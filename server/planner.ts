import { GoogleGenerativeAI, FunctionDeclaration, SchemaType } from '@google/generative-ai';
import { getRecentTurns, getUserProfile, searchHistory } from './memory/history';
import { searchFacts, getFactsByEntity } from './memory/facts';
import { webSearch } from './search';
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

  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    // Fallback heuristic planning if no API key is provided
    const lower = userMessage.toLowerCase();
    const isHistoryQuery = lower.includes('what did i ask') || lower.includes('on monday') || lower.includes('last tuesday') || lower.includes('last time');
    const isSearchQuery = lower.includes('pricing') || lower.includes('price') || lower.includes('changed') || lower.includes('shortlisted') || lower.includes('crm') || lower.includes('postgres') || lower.includes('search');

    if (isHistoryQuery) {
      const matchWord = lower.replace(/[^a-z0-9 ]/g, '').split(' ').filter(w => w.length > 3)[0] || '';
      const matches = searchHistory(userId, matchWord);
      historyMatches.push(...matches);
      onToolEvent({ type: 'recall_start', query: matchWord });
      onToolEvent({ type: 'recall_done', fact: `Found ${matches.length} history matches` });
    }

    if (isSearchQuery) {
      onToolEvent({ type: 'search_start', query: userMessage });
      const results = await webSearch(userMessage);
      searchResults.push(...results);
      onToolEvent({ type: 'search_done', query: userMessage, resultCount: results.length });
    }

    return { toolEvents, toolResults, searchResults, recalledFacts, historyMatches };
  }

  const systemPrompt = `You are the planning stage of an intelligent chat agent.
Current UTC datetime: ${now}
User profile summary: ${profile.summary || 'New user, no history yet.'}
User's tracked topics: ${profile.topics.join(', ') || 'none yet'}
User's known entities: ${Object.keys(profile.key_entities).join(', ') || 'none yet'}

Your job: analyze the user's message and decide what tools to call.
- If the user asks about past questions or dates (e.g. "What did I ask you on 3 November?", "Last Tuesday I asked..."): MUST call search_history
- If the user refers to past decisions, tools, entities, or asks if previous answers/pricing are still true: MUST call recall_facts and search_history
- If stored facts exist or are recalled, or if pricing/features need checking: call brave_search with intent 'verify_stale' or 'compare'
- When comparing multiple tools/entities: combine them into one batched OR query (e.g. "Salesforce OR HubSpot OR Pipedrive pricing")
- If purely conversational greetings with no info need: do not call tools`;

  const history = recentTurns.map(m => ({
    role: m.role === 'user' ? 'user' as const : 'model' as const,
    parts: [{ text: m.content }]
  }));

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: process.env.PLANNER_MODEL || 'gemini-2.0-flash',
      tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
      systemInstruction: systemPrompt
    });

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(userMessage);
    const functionCalls = result.response.functionCalls() || [];

    for (const call of functionCalls) {
      if (call.name === 'web_search' || call.name === 'brave_search') {
        const { query, intent } = call.args as any;
        onToolEvent({ type: intent === 'verify_stale' ? 'verify_start' : 'search_start', query });

        const results = await webSearch(query);
        searchResults.push(...results);
        toolResults[`search:${query}`] = results;

        onToolEvent({ type: intent === 'verify_stale' ? 'verify_done' : 'search_done', query, resultCount: results.length });

      } else if (call.name === 'recall_facts') {
        const { entities } = call.args as any;
        const entityList = Array.isArray(entities) ? entities : [String(entities)];
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

      } else if (call.name === 'search_history') {
        const { query, date_hint } = call.args as any;
        onToolEvent({ type: 'recall_start', query: `${query} (${date_hint || 'history'})` });
        const matches = searchHistory(userId, query, date_hint);
        historyMatches.push(...matches);
        toolResults[`history:${query}`] = matches;
        onToolEvent({ type: 'recall_done', fact: `Found ${matches.length} past conversation records` });
      }
    }
  } catch (err) {
    console.error('[planner] Error executing planner model:', err);
  }

  return { toolEvents, toolResults, searchResults, recalledFacts, historyMatches };
}
