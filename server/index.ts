import express from 'express';
import cors from 'cors';
import path from 'path';
import cron from 'node-cron';
import dotenv from 'dotenv';
dotenv.config();

import { authMiddleware, handleLogin, handleSignup } from './auth';
import { runPlanner } from './planner';
import { streamSynthesis } from './synthesizer';
import {
  saveMessage,
  appendToCache,
  getRecentTurns,
  getUserSessions,
  getUserProfile,
  ensureSession
} from './memory/history';
import { upsertFact } from './memory/facts';
import { recordFeedback } from './memory/feedback';
import { runCompressionJob } from './memory/compression';
import { embedText } from './embeddings';
import { getSearchUsageCount } from './search';
import db from './db';

const app = express();
app.use(cors());
app.use(express.json());

// Auth routes
app.post('/api/auth/signup', handleSignup);
app.post('/api/auth/login', handleLogin);

// Protected routes
app.use('/api/chat', authMiddleware);
app.use('/api/sessions', authMiddleware);
app.use('/api/feedback', authMiddleware);
app.use('/api/stats', authMiddleware);
app.use('/api/profile', authMiddleware);

app.get('/api/sessions', (req, res) => {
  const userId = (req as any).userId;
  res.json(getUserSessions(userId));
});

app.get('/api/profile', (req, res) => {
  const userId = (req as any).userId;
  const profile = getUserProfile(userId);
  const facts = db.prepare('SELECT entity, claim, importance, verified_at FROM facts WHERE user_id = ? ORDER BY verified_at DESC LIMIT 20').all(userId);
  res.json({ profile, facts });
});

app.post('/api/chat/stream', async (req, res) => {
  const userId = (req as any).userId;
  const { message, sessionId } = req.body;

  if (!message || !sessionId) {
    res.status(400).json({ error: 'message and sessionId are required' });
    return;
  }

  ensureSession(sessionId, userId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function sendSSE(event: string, data: unknown) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const userMsgId = saveMessage({
      session_id: sessionId,
      user_id: userId,
      role: 'user',
      content: message,
      tool_events: []
    });

    appendToCache(sessionId, {
      id: userMsgId,
      session_id: sessionId,
      user_id: userId,
      role: 'user',
      content: message,
      tool_events: [],
      created_at: new Date().toISOString()
    });

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
      message,
      recentTurns,
      plannerResult.searchResults,
      plannerResult.recalledFacts,
      plannerResult.historyMatches,
      profile.summary
    )) {
      if (chunk.token !== undefined) {
        fullAnswer += chunk.token;
        sendSSE('token', { token: chunk.token });
      }
      if (chunk.facts !== undefined) {
        extractedFacts = chunk.facts;
      }
    }

    const assistantMsgId = saveMessage({
      session_id: sessionId,
      user_id: userId,
      role: 'assistant',
      content: fullAnswer,
      tool_events: toolEvents
    });

    appendToCache(sessionId, {
      id: assistantMsgId,
      session_id: sessionId,
      user_id: userId,
      role: 'assistant',
      content: fullAnswer,
      tool_events: toolEvents,
      created_at: new Date().toISOString()
    });

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
    console.error('[stream] Error in chat stream:', err);
    sendSSE('error', { message: err.message || 'Internal error processing request' });
  } finally {
    res.end();
  }
});

app.post('/api/feedback', (req, res) => {
  const userId = (req as any).userId;
  const { messageId, signal, type = 'explicit' } = req.body;
  if (!messageId || (signal !== 1 && signal !== -1)) {
    res.status(400).json({ error: 'messageId and signal (1 or -1) are required' });
    return;
  }
  const msg = db.prepare('SELECT content FROM messages WHERE id = ? AND user_id = ?').get(messageId, userId) as any;
  if (!msg) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }
  recordFeedback(userId, messageId, signal, type, msg.content);
  res.json({ ok: true });
});

app.get('/api/stats', (_req, res) => {
  const count = getSearchUsageCount();
  res.json({
    search_calls_this_month: count,
    brave_calls_this_month: count,
    timestamp: new Date().toISOString()
  });
});

// Serve frontend in production or if client/dist exists
const clientDistPath = path.join(__dirname, '../dist/client');
app.use(express.static(clientDistPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexPath = path.join(clientDistPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) next();
  });
});

// Nightly compression job: 2 AM
cron.schedule('0 2 * * *', () => {
  runCompressionJob().catch(console.error);
});

// Clean expired search cache hourly
cron.schedule('0 * * * *', () => {
  db.prepare("DELETE FROM search_cache WHERE expires_at < datetime('now')").run();
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
});
