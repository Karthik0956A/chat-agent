import db from '../db';
import { Fact, ExtractedFact } from '../types';

function serializeEmbedding(embedding: number[]): Buffer {
  const f32 = new Float32Array(embedding);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function deserializeEmbedding(blob: any): Float32Array {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
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
  if (entities.length === 0) return [];
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
