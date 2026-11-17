import db from '../db';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

export async function runCompressionJob(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('[compression] Skipping: GEMINI_API_KEY not set');
    return;
  }

  console.log('[compression] Starting nightly compression job');
  const cutoff = new Date(Date.now() - 15 * 24 * 3600 * 1000).toISOString();

  const users = db.prepare(`
    SELECT DISTINCT user_id FROM messages WHERE created_at < ?
  `).all(cutoff) as { user_id: number }[];

  const genAI = new GoogleGenerativeAI(apiKey);

  for (const { user_id } of users) {
    await compressUserHistory(genAI, user_id, cutoff);
  }
  console.log(`[compression] Done. Processed ${users.length} users`);
}

async function compressUserHistory(genAI: GoogleGenerativeAI, userId: number, cutoff: string): Promise<void> {
  const oldMessages = db.prepare(`
    SELECT role, content FROM messages
    WHERE user_id = ? AND created_at < ?
    ORDER BY created_at ASC LIMIT 200
  `).all(userId, cutoff) as { role: string; content: string }[];

  if (oldMessages.length === 0) return;

  const transcript = oldMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  const model = genAI.getGenerativeModel({ model: process.env.PLANNER_MODEL || 'gemini-2.0-flash' });

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
    const cleanJson = text.replace(/```json\n?|\n?```/g, '').trim();
    const json = JSON.parse(cleanJson);

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
