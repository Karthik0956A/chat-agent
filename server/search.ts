import crypto from 'crypto';
import db from './db';
import { SearchResult } from './types';
import dotenv from 'dotenv';
dotenv.config();

import { GoogleGenerativeAI } from '@google/generative-ai';

async function buildSearchQuery(userQuestion: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here') return userQuestion;
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3-flash-preview',
      generationConfig: {
        maxOutputTokens: 100,
        // @ts-ignore
        thinkingConfig: { thinkingBudget: 0 }
      }
    });
    const prompt = `Convert this user question into an optimized web search query. Use advanced techniques: site: operators for authoritative sources when relevant, quotes for exact phrases, date hints for time-sensitive queries (append year ${new Date().getFullYear()}), OR for alternatives, -term to exclude noise. Return ONLY the final search query string, nothing else, no explanation.\n\nUser question: "${userQuestion}"`;
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('buildSearchQuery timeout')), 2500))
    ]) as any;
    const optimized = result.response.text().trim().replace(/^["']|["']$/g, '');
    if (optimized && optimized.length > 0) return optimized;
  } catch (err: any) {
    console.warn(`[search] buildSearchQuery notice: ${err?.message}. Using raw query.`);
  }
  return userQuestion;
}

const CACHE_TTL_HOURS = 6;

async function callTavilyAPI(query: string): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY || process.env.BRAVE_API_KEY;
  if (!apiKey || apiKey === 'your_tavily_api_key_here') {
    console.warn(`[search] TAVILY_API_KEY not configured. Returning local mock search for: "${query}"`);
    return [
      {
        title: `Search results for: ${query}`,
        url: `https://tavily.com/search?q=${encodeURIComponent(query)}`,
        description: `Tavily search preview for "${query}". Please configure TAVILY_API_KEY in .env to get live web search results.`,
        age: 'just now'
      }
    ];
  }

  const { tavily } = await import('@tavily/core');
  const client = tavily({ apiKey });

  let response: any;
  try {
    const searchPromise = client.search(query, {
      searchDepth: 'basic',
      maxResults: 6
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Tavily search timeout')), 4000)
    );
    response = await Promise.race([searchPromise, timeoutPromise]) as any;
  } catch (err: any) {
    console.warn(`[search] Tavily API notice: ${err?.message || err}. Continuing smoothly.`);
    return [];
  }

  try {
    db.prepare('INSERT INTO search_usage (query, provider) VALUES (?, ?)').run(query, 'tavily');
  } catch {
    try {
      db.prepare('INSERT INTO brave_usage (query) VALUES (?)').run(query);
    } catch {
      // Ignore if table not present
    }
  }

  return (response?.results || []).map((r: any) => ({
    title: r.title || 'Untitled',
    url: r.url || '',
    description: r.content || '',
    age: r.publishedDate || ''
  }));
}

export async function webSearch(query: string): Promise<SearchResult[]> {
  const hash = crypto.createHash('md5').update(query.toLowerCase().trim()).digest('hex');
  const now = new Date().toISOString();

  const cached = db.prepare(
    'SELECT results FROM search_cache WHERE query_hash = ? AND expires_at > ?'
  ).get(hash, now) as any;

  if (cached) {
    console.log(`[search] Cache hit: "${query}"`);
    return JSON.parse(cached.results);
  }

  console.log(`[search] Tavily API call: "${query}"`);
  const results = await callTavilyAPI(query);

  const expiresAt = new Date(Date.now() + CACHE_TTL_HOURS * 3600 * 1000).toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO search_cache (query_hash, query, results, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(hash, query, JSON.stringify(results), now, expiresAt);

  return results;
}

// Backward-compatible alias
export const braveSearch = webSearch;

export function buildBatchQuery(entities: string[], suffix: string): string {
  return entities.map(e => e.trim()).filter(Boolean).join(' OR ') + (suffix ? ` ${suffix}` : '');
}

export function getSearchUsageCount(): number {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM search_usage
      WHERE created_at > datetime('now', 'start of month')
    `).get() as any;
    if (row && Number(row.count) > 0) return Number(row.count);
  } catch {}

  try {
    const row = db.prepare(`
      SELECT COUNT(*) as count FROM brave_usage
      WHERE created_at > datetime('now', 'start of month')
    `).get() as any;
    return Number(row?.count || 0);
  } catch {}

  return 0;
}

export const getBraveUsageCount = getSearchUsageCount;

export { buildSearchQuery };
