import db from '../db';
import { Message, Session } from '../types';

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

  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = ? AND user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(sessionId, userId, CACHE_MAX_TURNS * 2) as any[];

  const messages = rows.reverse().map((r: any) => ({
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
  return Number(result.lastInsertRowid);
}

export function searchHistory(userId: number, query: string, dateHint?: string): Message[] {
  const sql = `SELECT * FROM messages WHERE user_id = ? AND content LIKE ?`;
  const params: (number | string)[] = [userId, `%${query}%`];
  const rows = db.prepare(sql + ' ORDER BY created_at DESC LIMIT 10').all(...params) as any[];
  return rows.map((r: any) => ({ ...r, tool_events: JSON.parse(r.tool_events || '[]') }));
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
