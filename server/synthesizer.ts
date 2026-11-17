import { GoogleGenerativeAI } from '@google/generative-ai';
import { SearchResult, Fact, Message, ExtractedFact } from './types';
import dotenv from 'dotenv';
dotenv.config();

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
- At the very end of your response, output a <FACTS> block with any critical facts worth remembering:
  <FACTS>{"facts":[{"entity":"Entity Name","claim":"Specific verifiable fact or pricing","source_url":"optional url","importance":0.0-1.0}]}</FACTS>
  Assign importance >= 0.6 only for valuable facts (shortlists, pricing, tools chosen, architecture decisions). Do not output the <FACTS> tag if there is nothing worth storing.`;

  const history = recentTurns.map(m => ({
    role: m.role === 'user' ? 'user' as const : 'model' as const,
    parts: [{ text: m.content }]
  }));

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: process.env.SYNTHESIZER_MODEL || 'gemini-2.0-flash',
    systemInstruction: systemPrompt
  });

  const chat = model.startChat({ history });
  const messageWithContext = context ? `${userMessage}\n\n---\n${context}` : userMessage;
  const stream = await chat.sendMessageStream(messageWithContext);

  let fullText = '';
  for await (const chunk of stream.stream) {
    const token = chunk.text();
    fullText += token;
    if (!fullText.includes('<FACTS>')) {
      yield { token };
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
