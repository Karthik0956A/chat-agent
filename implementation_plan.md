# Implementation Plan — Chat Agent (C+F+RL Hybrid)

> **For the building agent**: Follow phases in order. Each phase is independently testable. Do not skip ahead.
> **Stack**: TypeScript, Node.js, Express, React (Vite), SQLite (better-sqlite3), Gemini API, Brave Search API
> **Repo root**: `d:\minimi`

---

## Project Scaffold

```
/
├── server/                  # Express backend (TypeScript)
├── client/                  # React frontend (Vite + TypeScript)
├── data/                    # SQLite DB file (gitignored)
├── .env.example
├── .env                     # (gitignored)
├── DESIGN.md
├── package.json             # root — runs both server and client via concurrently
└── tsconfig.json
```

---

## Phase 0 — Repo & Tooling Setup

### `package.json` (root)
```json
{
  "name": "chat-agent",
  "version": "1.0.0",
  "scripts": {
    "dev": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
    "dev:server": "tsx watch server/index.ts",
    "dev:client": "vite client --port 5173",
    "build": "tsc -p server/tsconfig.json && vite build client --outDir ../dist/client",
    "start": "node dist/server/index.js"
  },
  "dependencies": {
    "@google/generative-ai": "^0.21.0",
    "better-sqlite3": "^9.4.3",
    "bcrypt": "^5.1.1",
    "jsonwebtoken": "^9.0.2",
    "express": "^4.18.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "uuid": "^9.0.1",
    "node-cron": "^3.0.3"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.8",
    "@types/bcrypt": "^5.0.2",
    "@types/jsonwebtoken": "^9.0.6",
    "@types/express": "^4.17.21",
    "@types/cors": "^2.8.17",
    "@types/uuid": "^9.0.8",
    "@types/node": "^20.12.0",
    "@types/node-cron": "^3.0.11",
    "tsx": "^4.7.2",
    "typescript": "^5.4.3",
    "concurrently": "^8.2.2",
    "vite": "^5.2.0",
    "@vitejs/plugin-react": "^4.2.1",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0"
  }
}
```

### `.env.example`
```
# Gemini API — https://aistudio.google.com/app/apikey
GEMINI_API_KEY=your_gemini_api_key_here

# Brave Search API — https://api.search.brave.com/
# Use your TEST account key during development
# Evaluators should paste their own key here
BRAVE_API_KEY=your_brave_search_api_key_here

# JWT secret — change to any random string in production
JWT_SECRET=change_me_to_a_random_string

# Models (can both be flash to save cost during dev, switch synthesizer to pro for submission)
PLANNER_MODEL=gemini-2.0-flash-exp
SYNTHESIZER_MODEL=gemini-2.0-flash-exp
EMBEDDING_MODEL=text-embedding-004

# Server
PORT=3000
DB_PATH=./data/agent.db
```

### `.gitignore`
```
node_modules/
data/
.env
dist/
client/dist/
*.js.map
```

### `server/tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "node",
    "outDir": "../dist/server",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

### `client/vite.config.ts`
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000'
    }
  }
});
```

---

## Phase 1 — Database Schema

### `server/db/schema.sql`
```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  tool_events TEXT DEFAULT '[]',   -- JSON array, displayed in UI
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  claim TEXT NOT NULL,
  source_url TEXT,
  embedding BLOB,                  -- serialized Float32Array (768 floats = 3072 bytes)
  importance REAL NOT NULL DEFAULT 0.5,
  reward_weight REAL NOT NULL DEFAULT 0.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  is_stale INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  summary TEXT DEFAULT '',
  topics TEXT DEFAULT '[]',        -- JSON array of strings
  key_entities TEXT DEFAULT '{}',  -- JSON object: entity -> brief description
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS search_cache (
  query_hash TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  results TEXT NOT NULL,           -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  signal INTEGER NOT NULL CHECK(signal IN (-1, 1)),
  type TEXT NOT NULL CHECK(type IN ('explicit', 'implicit')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS brave_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  query TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_user_session ON messages(user_id, session_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_facts_user ON facts(user_id);
CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(user_id, entity);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
```

### `server/db/index.ts`
```ts
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const DB_PATH = process.env.DB_PATH || './data/agent.db';

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Apply schema
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

export default db;
```

---

## Phase 2 — Types

### `server/types.ts`
```ts
export interface User {
  id: number;
  username: string;
  created_at: string;
}

export interface Session {
  id: string;
  user_id: number;
  title: string | null;
  created_at: string;
  last_active: string;
}

export interface Message {
  id: number;
  session_id: string;
  user_id: number;
  role: 'user' | 'assistant';
  content: string;
  tool_events: ToolEvent[];
  created_at: string;
}

export interface Fact {
  id: number;
  user_id: number;
  entity: string;
  claim: string;
  source_url: string | null;
  embedding: Buffer | null;
  importance: number;
  reward_weight: number;
  created_at: string;
  verified_at: string;
  is_stale: number;
}

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  age?: string;
}

export type ToolEventType =
  | 'search_start' | 'search_done'
  | 'recall_start' | 'recall_done'
  | 'verify_start' | 'verify_done'
  | 'converse';

export interface ToolEvent {
  type: ToolEventType;
  query?: string;
  entity?: string;
  fact?: string;
  age?: string;
  resultCount?: number;
  isStale?: boolean;
}

export interface PlannerTool {
  name: 'brave_search' | 'recall_facts' | 'search_history';
  args: Record<string, unknown>;
  intent: 'new_info' | 'verify_stale' | 'compare' | 'recall' | 'history';
}

export interface Plan {
  tools: PlannerTool[];
  reasoning: string;
}

export interface ExtractedFact {
  entity: string;
  claim: string;
  source_url?: string;
  importance: number;
}

// SSE event union
export type SSEEvent =
  | { event: 'tool_event'; data: ToolEvent }
  | { event: 'token'; data: { token: string } }
  | { event: 'done'; data: { messageId: number; facts_stored: string[] } }
  | { event: 'error'; data: { message: string } };
```

---

## Phase 3 — Memory Layer

### `server/memory/history.ts`
```ts
import db from '../db';
import { Message, Session } from '../types';

// In-memory LRU cache: sessionId -> last 6 messages
const sessionCache = new Map<string, Message[]>();
const CACHE_MAX_TURNS = 6;
const CACHE_TTL_MS = 30 * 60 * 1000;
const cacheTimestamps = new Map<string, number>();

function touchCache(sessionId: string) {
  cacheTimestamps.set(sessionId, Date.now());
}

function evictStale() {
  const now = Date.now();
  for (const [sid, ts] of cacheTimestamps) {
    if (now - ts > CACHE_TTL_MS) {
      sessionCache.delete(sid);
      cacheTimestamps.delete(sid);
    }
  }
}
setInterval(evictStale, 5 * 60 * 1000);

export function getRecentTurns(sessionId: string, userId: number): Message[] {
  if (sessionCache.has(sessionId)) {
    touchCache(sessionId);
    return sessionCache.get(sessionId)!;
  }
  // Load from DB (always scoped to userId for safety)
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ? AND user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(sessionId, userId, CACHE_MAX_TURNS * 2) as any[];

  const messages = rows.reverse().map(r => ({
    ...r,
    tool_events: JSON.parse(r.tool_events || '[]')
  })) as Message[];

  const recent = messages.slice(-CACHE_MAX_TURNS);
  sessionCache.set(sessionId, recent);
  touchCache(sessionId);
  return recent;
}

export function appendToCache(sessionId: string, message: Message) {
  const current = sessionCache.get(sessionId) || [];
  current.push(message);
  if (current.length > CACHE_MAX_TURNS) current.shift();
  sessionCache.set(sessionId, current);
  touchCache(sessionId);
}

export function saveMessage(msg: Omit<Message, 'id' | 'created_at'>): number {
  const result = db.prepare(`
    INSERT INTO messages (session_id, user_id, role, content, tool_events)
    VALUES (?, ?, ?, ?, ?)
  `).run(msg.session_id, msg.user_id, msg.role, msg.content, JSON.stringify(msg.tool_events));
  return result.lastInsertRowid as number;
}

export function searchHistory(userId: number, query: string, dateHint?: string): Message[] {
  const sql = `SELECT * FROM messages WHERE user_id = ? AND content LIKE ?`;
  const params: (number | string)[] = [userId, `%${query}%`];
  const rows = db.prepare(sql + ' ORDER BY created_at DESC LIMIT 10').all(...params) as any[];
  return rows.map(r => ({ ...r, tool_events: JSON.parse(r.tool_events || '[]') }));
}

export function ensureSession(sessionId: string, userId: number): void {
  const exists = db.prepare('SELECT id FROM sessions WHERE id = ? AND user_id = ?')
    .get(sessionId, userId);
  if (!exists) {
    db.prepare('INSERT OR IGNORE INTO sessions (id, user_id) VALUES (?, ?)')
      .run(sessionId, userId);
  }
  db.prepare('UPDATE sessions SET last_active = CURRENT_TIMESTAMP WHERE id = ?')
    .run(sessionId);
}

export function getUserSessions(userId: number): any[] {
  return db.prepare(`
    SELECT s.*,
      (SELECT content FROM messages WHERE session_id = s.id ORDER BY created_at LIMIT 1) as first_message
    FROM sessions s WHERE s.user_id = ? ORDER BY s.last_active DESC LIMIT 30
  `).all(userId) as any[];
}

export function getUserProfile(userId: number): { summary: string; topics: string[]; key_entities: Record<string, string> } {
  const row = db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(userId) as any;
  if (!row) return { summary: '', topics: [], key_entities: {} };
  return {
    summary: row.summary || '',
    topics: JSON.parse(row.topics || '[]'),
    key_entities: JSON.parse(row.key_entities || '{}')
  };
}
```

### `server/memory/facts.ts`
```ts
import db from '../db';
import { Fact, ExtractedFact } from '../types';

function serializeEmbedding(embedding: number[]): Buffer {
  const f32 = new Float32Array(embedding);
  return Buffer.from(f32.buffer);
}

function deserializeEmbedding(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function searchFacts(userId: number, queryEmbedding: number[], limit = 5): (Fact & { score: number })[] {
  const qVec = new Float32Array(queryEmbedding);
  const facts = db.prepare('SELECT * FROM facts WHERE user_id = ?').all(userId) as any[];

  return facts
    .filter((f: any) => f.embedding)
    .map((f: any) => ({
      ...f,
      score: cosineSimilarity(qVec, deserializeEmbedding(f.embedding)) * (1 + (f.reward_weight || 0))
    }))
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, limit) as (Fact & { score: number })[];
}

export function getFactsByEntity(userId: number, entities: string[]): Fact[] {
  const placeholders = entities.map(() => '?').join(',');
  return db.prepare(`
    SELECT * FROM facts WHERE user_id = ? AND LOWER(entity) IN (${placeholders})
    ORDER BY verified_at DESC
  `).all(userId, ...entities.map(e => e.toLowerCase())) as Fact[];
}

export function upsertFact(userId: number, fact: ExtractedFact, embedding: number[]): void {
  const existing = db.prepare(
    'SELECT id FROM facts WHERE user_id = ? AND LOWER(entity) = LOWER(?)'
  ).get(userId, fact.entity) as any;

  if (existing) {
    db.prepare(`
      UPDATE facts SET claim = ?, source_url = ?, embedding = ?,
        importance = ?, verified_at = CURRENT_TIMESTAMP, is_stale = 0
      WHERE id = ?
    `).run(fact.claim, fact.source_url || null, serializeEmbedding(embedding), fact.importance, existing.id);
  } else {
    db.prepare(`
      INSERT INTO facts (user_id, entity, claim, source_url, embedding, importance)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, fact.entity, fact.claim, fact.source_url || null, serializeEmbedding(embedding), fact.importance);
  }
}

export function updateRewardWeight(userId: number, entity: string, delta: number): void {
  db.prepare(`
    UPDATE facts
    SET reward_weight = MAX(-1.0, MIN(1.0, reward_weight + ?))
    WHERE user_id = ? AND LOWER(entity) = LOWER(?)
  `).run(delta, userId, entity.toLowerCase());
}

export function markStale(userId: number, entity: string): void {
  db.prepare('UPDATE facts SET is_stale = 1 WHERE user_id = ? AND LOWER(entity) = LOWER(?)')
    .run(userId, entity.toLowerCase());
}
```

### `server/memory/feedback.ts`
```ts
import db from '../db';
import { updateRewardWeight } from './facts';

function extractEntitiesSimple(text: string): string[] {
  const matches = text.match(/\b[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)*/g) || [];
  return [...new Set(matches)].filter(e => e.length > 2);
}

export function recordFeedback(
  userId: number,
  messageId: number,
  signal: 1 | -1,
  type: 'explicit' | 'implicit',
  messageContent?: string
): void {
  db.prepare('INSERT INTO feedback (user_id, message_id, signal, type) VALUES (?, ?, ?, ?)')
    .run(userId, messageId, signal, type);

  if (messageContent) {
    const entities = extractEntitiesSimple(messageContent);
    for (const entity of entities) {
      updateRewardWeight(userId, entity, signal * 0.05);
    }
  }
}
```

### `server/memory/compression.ts`
```ts
import db from '../db';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function runCompressionJob(): Promise<void> {
  console.log('[compression] Starting nightly compression job');
  const cutoff = new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString();

  const users = db.prepare(`
    SELECT DISTINCT user_id FROM messages WHERE created_at < ?
  `).all(cutoff) as { user_id: number }[];

  for (const { user_id } of users) {
    await compressUserHistory(user_id, cutoff);
  }
  console.log(`[compression] Done. Processed ${users.length} users`);
}

async function compressUserHistory(userId: number, cutoff: string): Promise<void> {
  const oldMessages = db.prepare(`
    SELECT role, content FROM messages
    WHERE user_id = ? AND created_at < ?
    ORDER BY created_at ASC LIMIT 200
  `).all(userId, cutoff) as { role: string; content: string }[];

  if (oldMessages.length === 0) return;

  const transcript = oldMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  const model = genAI.getGenerativeModel({ model: process.env.PLANNER_MODEL || 'gemini-2.0-flash-exp' });

  const prompt = `Analyze this conversation history and extract:
1. A 2-3 sentence summary of what this user cares about and their goals
2. Main topics they've researched (array of strings)
3. Key entities they track (object: entity name -> one-line description)

Return ONLY valid JSON: {"summary": "...", "topics": [...], "key_entities": {...}}

Conversation:
${transcript.slice(0, 8000)}`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const json = JSON.parse(text.replace(/```json\n?|\n?```/g, ''));

    const existing = db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').get(userId) as any;
    const existingTopics: string[] = existing ? JSON.parse(existing.topics || '[]') : [];
    const existingEntities: Record<string, string> = existing ? JSON.parse(existing.key_entities || '{}') : {};

    const mergedTopics = [...new Set([...existingTopics, ...(json.topics || [])])];
    const mergedEntities = { ...existingEntities, ...(json.key_entities || {}) };

    db.prepare(`
      INSERT INTO user_profiles (user_id, summary, topics, key_entities, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        summary = excluded.summary,
        topics = excluded.topics,
        key_entities = excluded.key_entities,
        updated_at = excluded.updated_at
    `).run(userId, json.summary || '', JSON.stringify(mergedTopics), JSON.stringify(mergedEntities));

    db.prepare('DELETE FROM messages WHERE user_id = ? AND created_at < ?').run(userId, cutoff);
    console.log(`[compression] User ${userId}: compressed ${oldMessages.length} messages`);
  } catch (err) {
    console.error(`[compression] Failed for user ${userId}:`, err);
  }
}
```

---

## Phase 4 — Search Layer

### `server/search.ts`
```ts
import crypto from 'crypto';
import db from './db';
import { SearchResult } from './types';
import dotenv from 'dotenv';
dotenv.config();

const BRAVE_API_KEY = process.env.BRAVE_API_KEY!;
const CACHE_TTL_HOURS = 6;

async function callBraveAPI(query: string): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&search_lang=en`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': BRAVE_API_KEY
    }
  });
  if (!res.ok) throw new Error(`Brave API error: ${res.status} ${await res.text()}`);

  const data = await res.json() as any;
  db.prepare('INSERT INTO brave_usage (query) VALUES (?)').run(query);

  return (data.web?.results || []).map((r: any) => ({
    title: r.title,
    url: r.url,
    description: r.description || r.extra_snippets?.join(' ') || '',
    age: r.age
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
  return entities.map(e => e.trim()).join(' OR ') + (suffix ? ` ${suffix}` : '');
}

export function getBraveUsageCount(): number {
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM brave_usage
    WHERE created_at > datetime('now', 'start of month')
  `).get() as any;
  return row.count;
}
```

---

## Phase 5 — Embeddings, Planner & Synthesizer

### `server/embeddings.ts`
```ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

export async function embedText(text: string): Promise<number[]> {
  const model = genAI.getGenerativeModel({ model: process.env.EMBEDDING_MODEL || 'text-embedding-004' });
  const result = await model.embedContent(text);
  return result.embedding.values;
}
```

### `server/planner.ts`
```ts
import { GoogleGenerativeAI, FunctionDeclaration, SchemaType } from '@google/generative-ai';
import { getRecentTurns, getUserProfile, searchHistory } from './memory/history';
import { searchFacts, getFactsByEntity } from './memory/facts';
import { braveSearch } from './search';
import { embedText } from './embeddings';
import { Message, ToolEvent, SearchResult, Fact } from './types';
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'brave_search',
    description: 'Search the web for current information. Use OR operator to batch multiple entities into one query (e.g. "Salesforce OR HubSpot pricing 2026").',
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
        query: { type: SchemaType.STRING },
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

  const systemPrompt = `You are the planning stage of a chat agent.
Current UTC datetime: ${now}
User profile summary: ${profile.summary || 'New user, no history yet.'}
User's tracked topics: ${profile.topics.join(', ') || 'none yet'}
User's known entities: ${Object.keys(profile.key_entities).join(', ') || 'none yet'}

Your job: analyze the user's message and decide what tools to call.
- If the user asks about something time-sensitive (pricing, news, features): search
- If the user refers to a past conversation or date: use search_history
- If you have stored facts about the entities: use recall_facts first, then decide if they need re-verification
- If the user asks to compare multiple items: batch them into one OR-search query
- If it's purely conversational with no info need: call no tools`;

  const history = recentTurns.map(m => ({
    role: m.role === 'user' ? 'user' as const : 'model' as const,
    parts: [{ text: m.content }]
  }));

  const model = genAI.getGenerativeModel({
    model: process.env.PLANNER_MODEL || 'gemini-2.0-flash-exp',
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    systemInstruction: systemPrompt
  });

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(userMessage);

  const toolEvents: ToolEvent[] = [];
  const toolResults: Record<string, unknown> = {};
  const searchResults: SearchResult[] = [];
  const recalledFacts: Fact[] = [];
  const historyMatches: Message[] = [];

  const functionCalls = result.response.functionCalls() || [];

  for (const call of functionCalls) {
    if (call.name === 'brave_search') {
      const { query } = call.args as any;
      onToolEvent({ type: 'search_start', query });
      const results = await braveSearch(query);
      searchResults.push(...results);
      toolResults[`search:${query}`] = results;
      onToolEvent({ type: 'search_done', query, resultCount: results.length });

    } else if (call.name === 'recall_facts') {
      const { entities } = call.args as any;
      onToolEvent({ type: 'recall_start', entity: entities.join(', ') });

      const byEntity = getFactsByEntity(userId, entities);
      if (byEntity.length === 0) {
        const queryEmbed = await embedText(entities.join(' '));
        const semantic = await searchFacts(userId, queryEmbed, 5);
        recalledFacts.push(...semantic);
        toolResults[`recall:${entities.join(',')}`] = semantic;
      } else {
        recalledFacts.push(...byEntity);
        toolResults[`recall:${entities.join(',')}`] = byEntity;
      }

      const topFact = recalledFacts[0];
      if (topFact) {
        const ageMs = Date.now() - new Date(topFact.verified_at).getTime();
        const ageDays = Math.floor(ageMs / (24 * 3600 * 1000));
        const ageStr = ageDays === 0 ? 'today' : ageDays === 1 ? '1 day ago' : `${ageDays} days ago`;
        onToolEvent({ type: 'recall_done', entity: topFact.entity, fact: topFact.claim, age: ageStr });
      }

    } else if (call.name === 'search_history') {
      const { query, date_hint } = call.args as any;
      const matches = searchHistory(userId, query, date_hint);
      historyMatches.push(...matches);
      toolResults[`history:${query}`] = matches;
    }
  }

  return { toolEvents, toolResults, searchResults, recalledFacts, historyMatches };
}
```

### `server/synthesizer.ts`
```ts
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SearchResult, Fact, Message, ExtractedFact } from './types';
import dotenv from 'dotenv';
dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

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
    context += '\n## Facts from memory:\n';
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

  const systemPrompt = `You are a helpful AI assistant with web search and memory capabilities.
Today is ${now}.
User profile: ${profileSummary || 'New user.'}

Guidelines:
- Be conversational and direct. Don't pad with filler.
- If a fact changed since you last stored it, explicitly say "Previously X, now Y" — make diffs visible.
- Cite sources inline as [1], [2] etc. referencing the search results list.
- If you're uncertain about recency, say so.
- After your response, on a new line output a JSON block ONLY if there are facts worth storing:
  <FACTS>{"facts":[{"entity":"...","claim":"...","source_url":"...","importance":0.0-1.0}]}</FACTS>
  Only store facts with importance >= 0.6. Pricing, features, and status changes qualify. Generic knowledge doesn't.`;

  const history = recentTurns.map(m => ({
    role: m.role === 'user' ? 'user' as const : 'model' as const,
    parts: [{ text: m.content }]
  }));

  const model = genAI.getGenerativeModel({
    model: process.env.SYNTHESIZER_MODEL || 'gemini-2.0-flash-exp',
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
```

---

## Phase 6 — Auth

### `server/auth.ts`
```ts
import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import db from './db';

const JWT_SECRET = process.env.JWT_SECRET || 'change_me';
const SALT_ROUNDS = 10;

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function signToken(userId: number, username: string): string {
  return jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '30d' });
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET) as { userId: number; username: string };
    (req as any).userId = payload.userId;
    (req as any).username = payload.username;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

export function handleSignup(req: Request, res: Response): void {
  const { username, password } = req.body;
  if (!username || !password || password.length < 6) {
    res.status(400).json({ error: 'Username and password (min 6 chars) required' });
    return;
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    res.status(409).json({ error: 'Username taken' });
    return;
  }
  const hash = hashPassword(password);
  const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  db.prepare('INSERT OR IGNORE INTO user_profiles (user_id) VALUES (?)').run(result.lastInsertRowid);
  const token = signToken(result.lastInsertRowid as number, username);
  res.json({ token, username });
}

export function handleLogin(req: Request, res: Response): void {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
  if (!user || !verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const token = signToken(user.id, user.username);
  res.json({ token, username: user.username });
}
```

---

## Phase 7 — Express Server & SSE

### `server/index.ts`
```ts
import express from 'express';
import cors from 'cors';
import path from 'path';
import cron from 'node-cron';
import dotenv from 'dotenv';
dotenv.config();

import { authMiddleware, handleLogin, handleSignup } from './auth';
import { runPlanner } from './planner';
import { streamSynthesis } from './synthesizer';
import { saveMessage, appendToCache, getRecentTurns, getUserSessions, getUserProfile, ensureSession } from './memory/history';
import { upsertFact } from './memory/facts';
import { recordFeedback } from './memory/feedback';
import { runCompressionJob } from './memory/compression';
import { embedText } from './embeddings';
import { getBraveUsageCount } from './search';
import db from './db';

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/auth/signup', handleSignup);
app.post('/api/auth/login', handleLogin);

app.use('/api/chat', authMiddleware);
app.use('/api/sessions', authMiddleware);
app.use('/api/feedback', authMiddleware);

app.get('/api/sessions', (req, res) => {
  const userId = (req as any).userId;
  res.json(getUserSessions(userId));
});

app.post('/api/chat/stream', async (req, res) => {
  const userId = (req as any).userId;
  const { message, sessionId } = req.body;

  if (!message || !sessionId) {
    res.status(400).json({ error: 'message and sessionId required' });
    return;
  }

  ensureSession(sessionId, userId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function sendSSE(event: string, data: unknown) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const userMsgId = saveMessage({ session_id: sessionId, user_id: userId, role: 'user', content: message, tool_events: [] });
    appendToCache(sessionId, { id: userMsgId, session_id: sessionId, user_id: userId, role: 'user', content: message, tool_events: [], created_at: new Date().toISOString() });

    const toolEvents: import('./types').ToolEvent[] = [];
    const plannerResult = await runPlanner(message, sessionId, userId, (event) => {
      toolEvents.push(event);
      sendSSE('tool_event', event);
    });

    const profile = getUserProfile(userId);
    const recentTurns = getRecentTurns(sessionId, userId);
    let fullAnswer = '';
    let extractedFacts: import('./types').ExtractedFact[] = [];

    for await (const chunk of streamSynthesis(
      message, recentTurns,
      plannerResult.searchResults, plannerResult.recalledFacts,
      plannerResult.historyMatches, profile.summary
    )) {
      if (chunk.token !== undefined) {
        fullAnswer += chunk.token;
        sendSSE('token', { token: chunk.token });
      }
      if (chunk.facts !== undefined) {
        extractedFacts = chunk.facts;
      }
    }

    const assistantMsgId = saveMessage({ session_id: sessionId, user_id: userId, role: 'assistant', content: fullAnswer, tool_events: toolEvents });
    appendToCache(sessionId, { id: assistantMsgId, session_id: sessionId, user_id: userId, role: 'assistant', content: fullAnswer, tool_events: toolEvents, created_at: new Date().toISOString() });

    const storedEntities: string[] = [];
    for (const fact of extractedFacts.filter(f => f.importance >= 0.6)) {
      try {
        const embedding = await embedText(`${fact.entity}: ${fact.claim}`);
        upsertFact(userId, fact, embedding);
        storedEntities.push(fact.entity);
      } catch (err) {
        console.error('[facts] Failed to embed/store fact:', err);
      }
    }

    sendSSE('done', { messageId: assistantMsgId, facts_stored: storedEntities });

  } catch (err: any) {
    console.error('[stream] Error:', err);
    sendSSE('error', { message: err.message || 'Internal error' });
  } finally {
    res.end();
  }
});

app.post('/api/feedback', (req, res) => {
  const userId = (req as any).userId;
  const { messageId, signal, type = 'explicit' } = req.body;
  if (!messageId || (signal !== 1 && signal !== -1)) {
    res.status(400).json({ error: 'messageId and signal (1 or -1) required' });
    return;
  }
  const msg = db.prepare('SELECT content FROM messages WHERE id = ? AND user_id = ?').get(messageId, userId) as any;
  if (!msg) { res.status(404).json({ error: 'Message not found' }); return; }
  recordFeedback(userId, messageId, signal, type, msg.content);
  res.json({ ok: true });
});

app.get('/api/stats', authMiddleware, (_req, res) => {
  res.json({ brave_calls_this_month: getBraveUsageCount() });
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../../client/dist')));
  app.get('*', (_, res) => res.sendFile(path.join(__dirname, '../../client/dist/index.html')));
}

cron.schedule('0 2 * * *', () => { runCompressionJob().catch(console.error); });
cron.schedule('0 * * * *', () => { db.prepare("DELETE FROM search_cache WHERE expires_at < datetime('now')").run(); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
```

---

## Phase 8 — React Client

### `client/index.html`
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Chat Agent</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/main.tsx"></script>
</body>
</html>
```

### `client/main.tsx`
```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
```

### `client/index.css`
```css
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #f0f0f0; height: 100vh; }
```

### `client/api.ts`
```ts
const BASE = '/api';

export function getToken() { return localStorage.getItem('token'); }
export function setToken(t: string) { localStorage.setItem('token', t); }
export function clearToken() { localStorage.removeItem('token'); }

function authHeaders() {
  return { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' };
}

export async function login(username: string, password: string) {
  const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export async function signup(username: string, password: string) {
  const res = await fetch(`${BASE}/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

export async function getSessions() {
  const res = await fetch(`${BASE}/sessions`, { headers: authHeaders() });
  return res.json();
}

export function streamChat(message: string, sessionId: string, onEvent: (e: { event: string; data: unknown }) => void): () => void {
  const controller = new AbortController();

  fetch(`${BASE}/chat/stream`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ message, sessionId }),
    signal: controller.signal
  }).then(async res => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) currentEvent = line.slice(7).trim();
        else if (line.startsWith('data: ')) {
          try { onEvent({ event: currentEvent, data: JSON.parse(line.slice(6)) }); }
          catch { /* skip malformed */ }
        }
      }
    }
  }).catch(err => { if (err.name !== 'AbortError') console.error(err); });

  return () => controller.abort();
}

export async function sendFeedback(messageId: number, signal: 1 | -1) {
  await fetch(`${BASE}/feedback`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ messageId, signal }) });
}
```

### `client/App.tsx`
```tsx
import React, { useState } from 'react';
import Auth from './pages/Auth';
import Chat from './pages/Chat';
import { getToken } from './api';

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  return authed ? <Chat onLogout={() => setAuthed(false)} /> : <Auth onAuth={() => setAuthed(true)} />;
}
```

### `client/pages/Auth.tsx`
```tsx
import React, { useState } from 'react';
import { login, signup, setToken } from '../api';

export default function Auth({ onAuth }: { onAuth: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const fn = mode === 'login' ? login : signup;
      const { token } = await fn(username, password);
      setToken(token);
      onAuth();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 300 }}>
        <h1 style={{ textAlign: 'center' }}>Chat Agent</h1>
        <input placeholder="Username" value={username} onChange={e => setUsername(e.target.value)}
          style={{ padding: 8, borderRadius: 6, border: '1px solid #333', background: '#1a1a1a', color: '#f0f0f0' }} />
        <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
          style={{ padding: 8, borderRadius: 6, border: '1px solid #333', background: '#1a1a1a', color: '#f0f0f0' }} />
        {error && <p style={{ color: '#f87171' }}>{error}</p>}
        <button type="submit" style={{ padding: 10, borderRadius: 6, background: '#6366f1', color: 'white', border: 'none', cursor: 'pointer' }}>
          {mode === 'login' ? 'Log In' : 'Sign Up'}
        </button>
        <button type="button" onClick={() => setMode(m => m === 'login' ? 'signup' : 'login')}
          style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer' }}>
          {mode === 'login' ? 'Create account' : 'Already have an account?'}
        </button>
      </form>
    </div>
  );
}
```

### `client/pages/Chat.tsx`
```tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { streamChat, sendFeedback, getSessions, clearToken } from '../api';

interface ToolEvent { type: string; query?: string; entity?: string; fact?: string; age?: string; resultCount?: number; }
interface ChatMessage { id?: number; role: 'user' | 'assistant'; content: string; toolEvents: ToolEvent[]; streaming?: boolean; }

const TOOL_ICONS: Record<string, string> = {
  search_start: '🔍', search_done: '✅',
  recall_start: '📋', recall_done: '📋',
  verify_start: '⚠️', verify_done: '✅',
};

function ToolStrip({ events }: { events: ToolEvent[] }) {
  if (!events.length) return null;
  return (
    <div style={{ fontSize: 12, color: '#888', margin: '4px 0', display: 'flex', flexDirection: 'column', gap: 2 }}>
      {events.map((e, i) => {
        const icon = TOOL_ICONS[e.type] || '⚙️';
        let label = '';
        if (e.type === 'search_start') label = `Searching: "${e.query}"`;
        else if (e.type === 'search_done') label = `Found ${e.resultCount} results for "${e.query}"`;
        else if (e.type === 'recall_start') label = `Looking up: ${e.entity}`;
        else if (e.type === 'recall_done') label = `Recalled: ${e.entity} — ${e.fact?.slice(0, 60)}... (${e.age})`;
        else if (e.type === 'verify_start') label = `Re-checking: ${e.entity}`;
        return <span key={i}>{icon} {label}</span>;
      })}
    </div>
  );
}

function Message({ msg, onFeedback }: { msg: ChatMessage; onFeedback: (id: number, s: 1 | -1) => void }) {
  const isUser = msg.role === 'user';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', margin: '8px 0' }}>
      {!isUser && <ToolStrip events={msg.toolEvents} />}
      <div style={{ maxWidth: '70%', padding: '10px 14px', borderRadius: 12, background: isUser ? '#6366f1' : '#1e1e1e', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
        {msg.content}
        {msg.streaming && <span style={{ opacity: 0.5 }}>▍</span>}
      </div>
      {!isUser && msg.id && !msg.streaming && (
        <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
          <button onClick={() => onFeedback(msg.id!, 1)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16 }}>👍</button>
          <button onClick={() => onFeedback(msg.id!, -1)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16 }}>👎</button>
        </div>
      )}
    </div>
  );
}

export default function Chat({ onLogout }: { onLogout: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sessionId] = useState(uuidv4);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { getSessions().then(setSessions).catch(() => {}); }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const sendMessage = useCallback(() => {
    if (!input.trim() || isStreaming) return;
    const text = input;
    setMessages(prev => [...prev, { role: 'user', content: text, toolEvents: [] }]);
    setInput('');
    setIsStreaming(true);
    setMessages(prev => [...prev, { role: 'assistant', content: '', toolEvents: [], streaming: true }]);

    streamChat(text, sessionId, ({ event, data }) => {
      if (event === 'tool_event') {
        setMessages(prev => { const n = [...prev]; const l = { ...n[n.length - 1] }; l.toolEvents = [...l.toolEvents, data as ToolEvent]; n[n.length - 1] = l; return n; });
      } else if (event === 'token') {
        setMessages(prev => { const n = [...prev]; const l = { ...n[n.length - 1] }; l.content += (data as any).token; n[n.length - 1] = l; return n; });
      } else if (event === 'done') {
        setMessages(prev => { const n = [...prev]; const l = { ...n[n.length - 1] }; l.streaming = false; l.id = (data as any).messageId; n[n.length - 1] = l; return n; });
        setIsStreaming(false);
      } else if (event === 'error') {
        setIsStreaming(false);
      }
    });
  }, [input, sessionId, isStreaming]);

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <div style={{ width: 220, background: '#111', borderRight: '1px solid #222', padding: 12, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Sessions</div>
        {sessions.map(s => (
          <div key={s.id} style={{ padding: '6px 8px', borderRadius: 6, fontSize: 13, color: '#999', cursor: 'pointer' }}>
            {s.first_message?.slice(0, 30) || 'New chat'}
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={() => { clearToken(); onLogout(); }}
          style={{ padding: 8, background: 'none', border: '1px solid #333', color: '#888', borderRadius: 6, cursor: 'pointer' }}>
          Log out
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 48px' }}>
          {messages.length === 0 && (
            <div style={{ textAlign: 'center', color: '#444', marginTop: '20vh' }}>
              <h2>Chat Agent</h2>
              <p>Ask me anything. I can search the web and remember our conversations.</p>
            </div>
          )}
          {messages.map((msg, i) => <Message key={i} msg={msg} onFeedback={async (id, s) => { await sendFeedback(id, s); }} />)}
          <div ref={bottomRef} />
        </div>

        <div style={{ padding: '16px 48px', borderTop: '1px solid #222', display: 'flex', gap: 8 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            placeholder="Message... (Enter to send, Shift+Enter for newline)"
            rows={2}
            style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid #333', background: '#1a1a1a', color: '#f0f0f0', resize: 'none', fontFamily: 'inherit' }}
          />
          <button onClick={sendMessage} disabled={isStreaming || !input.trim()}
            style={{ padding: '0 20px', borderRadius: 8, background: '#6366f1', color: 'white', border: 'none', cursor: 'pointer', opacity: isStreaming || !input.trim() ? 0.5 : 1 }}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

## Phase 9 — Verification & Testing

```bash
# 1. Install
npm install

# 2. Set up env
cp .env.example .env
# Edit .env — fill in GEMINI_API_KEY and BRAVE_API_KEY

# 3. Start dev
npm run dev
# Server: http://localhost:3000
# Client: http://localhost:5173

# 4. Verify DB tables
# After first run: data/agent.db should exist
# Tables: users, sessions, messages, facts, user_profiles, search_cache, feedback, brave_usage

# 5. Test auth
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"password123"}'
# Expected: {"token":"...","username":"test"}
```

### Benchmark Scenarios

**Scenario 1 — Multi-entity comparison**
1. Session 1: "Compare Salesforce, HubSpot, and Pipedrive pricing for a 20-person team"
2. New session: "Has any of those CRM tools changed pricing since Monday?"
3. ✅ Agent recalls stored facts → re-searches → diffs

**Scenario 2 — Historical recall**
1. Ask anything today
2. New session: "What did I ask you on [today's date]?"
3. ✅ Agent searches history → finds the message → re-verifies if needed

**Scenario 3 — Staleness detection**
1. Ask about Postgres hosting providers
2. New session: "Has any pricing changed since last time?"
3. ✅ Agent recalls stored provider facts → re-searches → narrates changes

---

## Phase 10 — Submission Checklist

- [ ] `npm install && npm run dev` runs clean from scratch
- [ ] All DB queries have `WHERE user_id = ?` (no cross-user leakage)
- [ ] `.env.example` lists all required keys with comments
- [ ] `DESIGN.md` is in repo root
- [ ] `data/` and `.env` are in `.gitignore`
- [ ] Brave test key used during dev; prod key ready for submission
- [ ] 👍/👎 buttons work and trigger feedback DB writes
- [ ] Tool status strip shows in UI during responses
- [ ] Compression job can be triggered: `npx tsx -e "import('./server/memory/compression.ts').then(m => m.runCompressionJob())"`
