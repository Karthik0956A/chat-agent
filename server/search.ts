import crypto from 'crypto';
import db from './db';
import { SearchResult } from './types';
import dotenv from 'dotenv';
dotenv.config();

const CACHE_TTL_HOURS = 6;

async function callBraveAPI(query: string): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey || apiKey === 'your_brave_search_api_key_here') {
    console.warn(`[search] BRAVE_API_KEY not configured. Returning local mock search for: "${query}"`);
    return [
      {
        title: `Search results for: ${query}`,
        url: `https://search.brave.com/search?q=${encodeURIComponent(query)}`,
        description: `Brave search preview for "${query}". Please configure a valid BRAVE_API_KEY in .env to get live web search results.`,
        age: 'just now'
      }
    ];
  }

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&search_lang=en`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey
    }
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Brave API error (${res.status}): ${errorBody}`);
  }

  const data = await res.json() as any;

  db.prepare('INSERT INTO brave_usage (query) VALUES (?)').run(query);

  return (data.web?.results || []).map((r: any) => ({
    title: r.title || 'Untitled',
    url: r.url || '',
    description: r.description || r.extra_snippets?.join(' ') || '',
    age: r.age || ''
  }));
}

export async function braveSearch(query: string): Promise<SearchResult[]> {
  const hash = crypto.createHash('md5').update(query.toLowerCase().trim()).digest('hex');
  const now = new Date().toISOString();

  const cached = db.prepare(
    'SELECT results FROM search_cache WHERE query_hash = ? AND expires_at > ?'
  ).get(hash, now) as any;

  if (cached) {
    console.log(`[search] Cache hit: "${query}"`);
    return JSON.parse(cached.results);
  }

  console.log(`[search] Brave API call: "${query}"`);
  const results = await callBraveAPI(query);

  const expiresAt = new Date(Date.now() + CACHE_TTL_HOURS * 3600 * 1000).toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO search_cache (query_hash, query, results, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(hash, query, JSON.stringify(results), now, expiresAt);

  return results;
}

export function buildBatchQuery(entities: string[], suffix: string): string {
  return entities.map(e => e.trim()).filter(Boolean).join(' OR ') + (suffix ? ` ${suffix}` : '');
}

export function getBraveUsageCount(): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM brave_usage
    WHERE created_at > datetime('now', 'start of month')
  `).get() as any;
  return Number(row?.count || 0);
}
