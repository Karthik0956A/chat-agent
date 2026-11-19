import { GoogleGenerativeAI } from '@google/generative-ai';
import { SearchResult, Fact, Message, ExtractedFact } from './types';
import dotenv from 'dotenv';
dotenv.config();

function getSafeModelName(name?: string): string {
  if (!name) return 'gemini-3-flash-preview';
  let m = name.trim();
  if (m === 'gemini-3.1-flash-preview' || m === 'gemini-3.1-pro-preview') return 'gemini-3-flash-preview';
  if (m.includes('pro')) return 'gemini-3-flash-preview';
  if (m === 'gemini-2.0-flash' || m === 'gemini-2.0-pro') return 'gemini-2.5-flash';
  return m;
}

const CANDIDATE_SYNTHESIZER_MODELS = ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-3.5-flash-lite'];

function formatGeminiHistory(turns: Message[]): { role: 'user' | 'model'; parts: { text: string }[] }[] {
  const result: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];
  const valid = turns.filter(m => m.content && m.content.trim());
  
  // Find first user message (Gemini strictly requires history to start with role 'user')
  const firstUserIdx = valid.findIndex(m => m.role === 'user');
  if (firstUserIdx === -1) return [];

  for (let i = firstUserIdx; i < valid.length; i++) {
    const role: 'user' | 'model' = valid[i].role === 'user' ? 'user' : 'model';
    if (result.length > 0 && result[result.length - 1].role === role) {
      result[result.length - 1].parts[0].text += '\n' + valid[i].content;
    } else {
      result.push({ role, parts: [{ text: valid[i].content }] });
    }
  }

  // Remove trailing user turn so chat.sendMessage() supplies the next user turn
  if (result.length > 0 && result[result.length - 1].role === 'user') {
    result.pop();
  }

  return result;
}

export async function* streamSynthesis(
  userMessage: string,
  recentTurns: Message[],
  searchResults: SearchResult[],
  recalledFacts: Fact[],
  historyMatches: Message[],
  profileSummary: string
): AsyncGenerator<{ token?: string; facts?: ExtractedFact[] }> {
  const now = new Date().toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'full' });

  let context = '';
  if (recalledFacts.length > 0) {
    context += '\n## Facts from personal memory:\n';
    context += recalledFacts.map(f => {
      const age = Math.floor((Date.now() - new Date(f.verified_at).getTime()) / (24 * 3600 * 1000));
      return `- ${f.entity}: ${f.claim} (verified ${age === 0 ? 'today' : `${age} days ago`}${f.is_stale ? ', POSSIBLY STALE' : ''}, source: ${f.source_url || 'unknown'})`;
    }).join('\n');
  }
  if (searchResults.length > 0) {
    context += '\n## Fresh web search results:\n';
    context += searchResults.slice(0, 8).map((r, i) =>
      `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.description}${r.age ? ` (${r.age})` : ''}`
    ).join('\n\n');
  }
  if (historyMatches.length > 0) {
    context += '\n## Relevant past conversation turns:\n';
    context += historyMatches.slice(0, 5).map(m =>
      `[${new Date(m.created_at).toLocaleDateString()}] ${m.role.toUpperCase()}: ${m.content.slice(0, 300)}`
    ).join('\n');
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    const demoReply = `I noticed you asked: "${userMessage}".\n\n` +
      (searchResults.length > 0
        ? `Found ${searchResults.length} web search result(s):\n` + searchResults.map((s, idx) => `[${idx + 1}] ${s.title}: ${s.description}`).join('\n')
        : (recalledFacts.length > 0
            ? `Recalled from memory: ${recalledFacts.map(f => `${f.entity} -> ${f.claim}`).join(', ')}`
            : `Hello! I have persistent memory across sessions and web search capability. Please configure your \`GEMINI_API_KEY\` and \`BRAVE_API_KEY\` in \`.env\` to enable live Gemini answers and live Brave search.`));

    for (const char of demoReply) {
      yield { token: char };
    }
    yield {
      facts: [
        {
          entity: 'Chat Agent',
          claim: 'Running with multi-layer persistent memory and web search',
          importance: 0.8
        }
      ]
    };
    return;
  }

  const systemPrompt = `You are a helpful AI assistant with live web search and persistent memory.
Today is ${now}.
User profile: ${profileSummary || 'New user.'}

Guidelines:
- Be conversational, accurate, and direct.
- When answering questions about past decisions, shortlist items, or past dates: reference the remembered facts or past conversations accurately.
- If a fact has changed since you previously discussed it (e.g. pricing, features, announcements), explicitly highlight the difference: "Previously it was X, but currently it is Y".
- Cite fresh sources inline using [1], [2], etc., matching the search results.
- CRITICAL — History Accuracy: If the user asks about a specific date/day/time and the historyMatches context is empty or the relevant past conversation turns section shows nothing matching that date, you MUST state clearly "I found no conversation from [the requested date]". If you do have nearby dates from the conversation history, suggest them: "However, you spoke about X on [nearby date] — is that what you meant?". NEVER fabricate or hallucinate past conversations.
- At the very end of your response, output a <FACTS> block with any critical facts worth remembering:
  <FACTS>{"facts":[{"entity":"Entity Name","claim":"Specific verifiable fact or pricing","source_url":"optional url","importance":0.0-1.0}]}</FACTS>
  Assign importance >= 0.6 only for valuable facts (shortlists, pricing, tools chosen, architecture decisions). Do not output the <FACTS> tag if there is nothing worth storing.`;

  const history = formatGeminiHistory(recentTurns);

  const genAI = new GoogleGenerativeAI(apiKey);
  const targetModel = getSafeModelName(process.env.SYNTHESIZER_MODEL);
  const modelCandidates = Array.from(new Set([targetModel, ...CANDIDATE_SYNTHESIZER_MODELS]));
  const messageWithContext = context ? `${userMessage}\n\n---\n${context}` : userMessage;

  let stream: any = null;
  let activeModel = targetModel;

  for (const candidate of modelCandidates) {
    try {
      const model = genAI.getGenerativeModel({
        model: candidate,
        systemInstruction: systemPrompt,
        generationConfig: {
          // @ts-ignore
          thinkingConfig: { thinkingBudget: 0 }
        }
      });
      const chat = model.startChat({ history });
      stream = await chat.sendMessageStream(messageWithContext);
      activeModel = candidate;
      console.log(`  -> [SYNTHESIS ENGINE] Active model: ${activeModel} (zero-thinking fast streaming)`);
      break;
    } catch (err: any) {
      console.warn(`[synthesizer] Model ${candidate} notice: ${err?.message || err}. Trying next fallback...`);
    }
  }

  if (!stream) {
    const fallbackText = `I encountered a temporary service limitation contacting Gemini. Here is what I retrieved:\n\n` +
      (searchResults.length > 0 ? searchResults.map((s, idx) => `[${idx + 1}] **${s.title}**\n${s.description}\nSource: ${s.url}`).join('\n\n') : 'Please try your query again.');
    for (const char of fallbackText) {
      yield { token: char };
    }
    yield { facts: [] };
    return;
  }

  let fullText = '';
  try {
    for await (const chunk of stream.stream) {
      const token = chunk.text();
      fullText += token;
      if (!fullText.includes('<FACTS>')) {
        yield { token };
      }
    }
  } catch (streamErr: any) {
    console.warn(`[synthesizer] Stream interrupted on ${activeModel}:`, streamErr?.message || streamErr);
    if (!fullText) {
      const errNotice = `\n\n*(Notice: streaming connection closed early. Displaying available search context:)*\n` +
        searchResults.map(s => `- ${s.title}: ${s.description}`).join('\n');
      yield { token: errNotice };
    }
  }

  const factsMatch = fullText.match(/<FACTS>([\s\S]*?)<\/FACTS>/);
  if (factsMatch) {
    try {
      const parsed = JSON.parse(factsMatch[1]);
      yield { facts: parsed.facts || [] };
    } catch {
      yield { facts: [] };
    }
  } else {
    yield { facts: [] };
  }
}
