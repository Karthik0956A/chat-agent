import db from '../db';
import { updateRewardWeight } from './facts';

function extractEntitiesSimple(text: string): string[] {
  const matches = text.match(/\b[A-Z][a-zA-Z0-9]+(?:\s[A-Z][a-zA-Z0-9]+)*/g) || [];
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
