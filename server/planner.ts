import { GoogleGenerativeAI, FunctionDeclaration, SchemaType } from '@google/generative-ai';
import { getRecentTurns, getUserProfile, searchHistory } from './memory/history';
import { searchFacts, getFactsByEntity } from './memory/facts';
import { webSearch, buildSearchQuery } from './search';
import { embedText } from './embeddings';
import { Message, ToolEvent, SearchResult, Fact } from './types';
import dotenv from 'dotenv';
dotenv.config();

const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'web_search',
    description: 'Search the live web using Tavily for current information. Use OR operator to batch multiple entities into one query (e.g. "Salesforce OR HubSpot pricing 2026").',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: 'The search query' },
        intent: {
          type: SchemaType.STRING,
          enum: ['new_info', 'verify_stale', 'compare'],
          description: 'Why you are searching'
        },
        entities: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Named entities this search is about'
        }
      },
      required: ['query', 'intent']
    }
  },
  {
    name: 'recall_facts',
    description: "Retrieve stored facts from the user's personal memory about specific entities.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entities: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Entity names to look up'
        }
      },
      required: ['entities']
    }
  },
  {
    name: 'search_history',
    description: 'Search past conversations to find what was discussed on a specific topic or date.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: 'Keywords to look up in chat history' },
        date_hint: { type: SchemaType.STRING, description: 'e.g. "3 November", "last Tuesday", "Monday"' }
      },
      required: ['query']
    }
  }
];

export interface PlannerResult {
  toolEvents: ToolEvent[];
  toolResults: Record<string, unknown>;
  searchResults: SearchResult[];
  recalledFacts: Fact[];
  historyMatches: Message[];
}

function getSafePlannerModel(name?: string): string {
  if (!name) return 'gemini-2.5-flash';
  let m = name.trim();
  if (m === 'gemini-3.1-flash-preview' || m === 'gemini-3.1-pro-preview') return 'gemini-2.5-flash';
  if (m.includes('pro')) return 'gemini-2.5-flash';
  if (m === 'gemini-2.0-flash' || m === 'gemini-2.0-pro') return 'gemini-2.5-flash';
  return m;
}

const CANDIDATE_PLANNER_MODELS = ['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite'];

function formatGeminiHistory(turns: Message[]): { role: 'user' | 'model'; parts: { text: string }[] }[] {
  const result: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];
  const valid = turns.filter(m => m.content && m.content.trim());
  
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

  if (result.length > 0 && result[result.length - 1].role === 'user') {
    result.pop();
  }

  return result;
}

export async function runPlanner(
  userMessage: string,
  sessionId: string,
  userId: number,
  onToolEvent: (event: ToolEvent) => void
): Promise<PlannerResult> {
  const recentTurns = getRecentTurns(sessionId, userId);
  const profile = getUserProfile(userId);
  const now = new Date().toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'full', timeStyle: 'short' });

  const toolEvents: ToolEvent[] = [];
  const toolResults: Record<string, unknown> = {};
  const searchResults: SearchResult[] = [];
  const recalledFacts: Fact[] = [];
  const historyMatches: Message[] = [];

  const apiKey = process.env.GEMINI_API_KEY;

  // Fast-path intent matching: gives instant (0ms) routing for obvious user intents
  const lower = userMessage.toLowerCase();
  const isHistoryQuery = lower.includes('what did i ask') || lower.includes('on monday') || lower.includes('last tuesday') || lower.includes('last time') || lower.includes('history') || lower.includes('previous conversation') || lower.includes('did we discuss');
  const isSearchQuery = lower.includes('pricing') || lower.includes('price') || lower.includes('cost') || lower.includes('changed') || lower.includes('shortlisted') || lower.includes('crm') || lower.includes('postgres') || lower.includes('search') || lower.includes('trending') || lower.includes('today') || lower.includes('news') || lower.includes('latest') || lower.includes('top 10') || lower.includes('twitter') || lower.includes('compare');

  // If high-confidence query, execute tools directly for instant sub-second response
  if (isHistoryQuery) {
    console.log(`  -> [PLANNER INTENT] Detected past conversation / history query`);
    const matchWord = lower.replace(/[^a-z0-9 ]/g, '').split(' ').filter(w => w.length > 3 && !['what', 'that', 'this', 'have', 'from', 'with'].includes(w))[0] || '';
    console.log(`  -> [TOOL: HISTORY SEARCH START] Matching keyword: "${matchWord}"`);
    const matches = searchHistory(userId, matchWord);
    historyMatches.push(...matches);
    onToolEvent({ type: 'recall_start', query: matchWord || 'conversation history' });
    onToolEvent({ type: 'recall_done', fact: `Found ${matches.length} history matches` });
    console.log(`  -> [TOOL: HISTORY SEARCH DONE] Retrieved ${matches.length} past conversation records`);
  }

  if (isSearchQuery) {
    console.log(`  -> [PLANNER INTENT] Detected live search / freshness query`);
    const optimizedQuery = await buildSearchQuery(userMessage);
    console.log(`  -> [TOOL: WEB SEARCH] Original: "${userMessage}" → Optimized: "${optimizedQuery}"`);
    onToolEvent({ type: 'search_start', query: optimizedQuery });
    const results = await webSearch(optimizedQuery);
    searchResults.push(...results);
    onToolEvent({ type: 'search_done', query: optimizedQuery, resultCount: results.length });
    console.log(`  -> [TOOL: WEB SEARCH DONE] Tavily returned ${results.length} search results`);
  }

  // Also check if any known entities or facts should be recalled
  const knownEntities = Object.keys(profile.key_entities);
  const mentionedEntities = knownEntities.filter(e => lower.includes(e.toLowerCase()));
  if (mentionedEntities.length > 0) {
    console.log(`  -> [TOOL: FACT RECALL START] Looking up profile facts for entities: [${mentionedEntities.join(', ')}]`);
    const byEntity = getFactsByEntity(userId, mentionedEntities);
    recalledFacts.push(...byEntity);
    if (byEntity.length > 0) {
      onToolEvent({ type: 'recall_start', entity: mentionedEntities.join(', ') });
      onToolEvent({ type: 'recall_done', entity: byEntity[0].entity, fact: byEntity[0].claim });
      console.log(`  -> [TOOL: FACT RECALL DONE] Found ${byEntity.length} remembered facts`);
    }
  }

  // If fast-path resolved the required tools, return immediately!
  if (searchResults.length > 0 || historyMatches.length > 0 || recalledFacts.length > 0) {
    console.log(`  -> [PLANNER COMPLETE] Resolved via high-speed router.`);
    return { toolEvents, toolResults, searchResults, recalledFacts, historyMatches };
  }

  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    return { toolEvents, toolResults, searchResults, recalledFacts, historyMatches };
  }

  console.log(`  -> [PLANNER LLM] Running LLM function-calling routing...`);

  const systemPrompt = `You are the planning stage of an intelligent chat agent.
Current UTC datetime: ${now}
User profile summary: ${profile.summary || 'New user, no history yet.'}
User's tracked topics: ${profile.topics.join(', ') || 'none yet'}
User's known entities: ${Object.keys(profile.key_entities).join(', ') || 'none yet'}

Your job: analyze the user's message and decide what tools to call.
- If the user asks about past questions or dates (e.g. "What did I ask you on 3 November?", "Last Tuesday I asked..."): MUST call search_history
- If the user refers to past decisions, tools, entities, or asks if previous answers/pricing are still true: MUST call recall_facts and search_history
- If user asks for latest news, trending topics, pricing, or fresh information: MUST call web_search
- When comparing multiple tools/entities: combine them into one batched OR query (e.g. "Salesforce OR HubSpot OR Pipedrive pricing")
- If purely conversational greetings with no info need: do not call tools`;

  const history = formatGeminiHistory(recentTurns);

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const targetModel = getSafePlannerModel(process.env.PLANNER_MODEL);

    let result: any = null;
    try {
      const model = genAI.getGenerativeModel({
        model: targetModel,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        systemInstruction: systemPrompt
      });
      const chat = model.startChat({ history });

      const planPromise = chat.sendMessage(userMessage);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Planner timeout on ${targetModel}`)), 3000)
      );

      result = await Promise.race([planPromise, timeoutPromise]);
    } catch (err: any) {
      console.warn(`[planner] Model ${targetModel} notice: ${err?.message || err}.`);
    }

    const functionCalls = result?.response?.functionCalls?.() || [];

    for (const call of functionCalls) {
      if (call.name === 'web_search' || call.name === 'brave_search') {
        const { query, intent } = call.args as any;
        console.log(`  -> [LLM TOOL: WEB SEARCH] Intent: ${intent} | Query: "${query}"`);
        onToolEvent({ type: intent === 'verify_stale' ? 'verify_start' : 'search_start', query });

        const results = await webSearch(query);
        searchResults.push(...results);
        toolResults[`search:${query}`] = results;

        onToolEvent({ type: intent === 'verify_stale' ? 'verify_done' : 'search_done', query, resultCount: results.length });
        console.log(`  -> [LLM TOOL: WEB SEARCH DONE] Retrieved ${results.length} results`);

      } else if (call.name === 'recall_facts') {
        const { entities } = call.args as any;
        const entityList = Array.isArray(entities) ? entities : [String(entities)];
        console.log(`  -> [LLM TOOL: FACT RECALL] Looking up entities: [${entityList.join(', ')}]`);
        onToolEvent({ type: 'recall_start', entity: entityList.join(', ') });

        const byEntity = getFactsByEntity(userId, entityList);
        if (byEntity.length === 0) {
          const queryEmbed = await embedText(entityList.join(' '));
          const semantic = await searchFacts(userId, queryEmbed, 5);
          recalledFacts.push(...semantic);
          toolResults[`recall:${entityList.join(',')}`] = semantic;
        } else {
          recalledFacts.push(...byEntity);
          toolResults[`recall:${entityList.join(',')}`] = byEntity;
        }

        const topFact = recalledFacts[0];
        if (topFact) {
          const ageMs = Date.now() - new Date(topFact.verified_at).getTime();
          const ageDays = Math.floor(ageMs / (24 * 3600 * 1000));
          const ageStr = ageDays === 0 ? 'today' : ageDays === 1 ? '1 day ago' : `${ageDays} days ago`;
          onToolEvent({ type: 'recall_done', entity: topFact.entity, fact: topFact.claim, age: ageStr });
        } else {
          onToolEvent({ type: 'recall_done', entity: entityList.join(', '), fact: 'No stored facts found' });
        }
        console.log(`  -> [LLM TOOL: FACT RECALL DONE] Recalled ${recalledFacts.length} facts`);

      } else if (call.name === 'search_history') {
        const { query, date_hint } = call.args as any;
        console.log(`  -> [LLM TOOL: HISTORY SEARCH] Query: "${query}" | date_hint: "${date_hint || 'none'}"`);
        onToolEvent({ type: 'recall_start', query: `${query} (${date_hint || 'history'})` });
        const matches = searchHistory(userId, query, date_hint);
        historyMatches.push(...matches);
        toolResults[`history:${query}`] = matches;
        onToolEvent({ type: 'recall_done', fact: `Found ${matches.length} past conversation records` });
        console.log(`  -> [LLM TOOL: HISTORY SEARCH DONE] Found ${matches.length} matches`);
      }
    }
  } catch (err) {
    console.error('[planner] Error executing planner model:', err);
  }

  return { toolEvents, toolResults, searchResults, recalledFacts, historyMatches };
}
