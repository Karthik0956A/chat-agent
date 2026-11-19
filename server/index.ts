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
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
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
app.use('/api/messages', authMiddleware);

app.get('/api/messages/:sessionId', (req, res) => {
  const userId = (req as any).userId;
  const { sessionId } = req.params;
  const rows = db.prepare(
    'SELECT * FROM messages WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT 100'
  ).all(sessionId, userId) as any[];
  res.json(rows.map(r => ({ ...r, tool_events: JSON.parse(r.tool_events || '[]') })));
});

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

  const queryStartTime = Date.now();
  console.log('\n================================================================');
  console.log(`[STAGE 1: INCOMING REQUEST] User #${userId} | Session: ${sessionId}`);
  console.log(`[STAGE 1: QUERY] "${message}"`);
  console.log('----------------------------------------------------------------');

  ensureSession(sessionId, userId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let isClientConnected = true;
  res.on('close', () => {
    if (!res.writableEnded) {
      isClientConnected = false;
      console.log(`[STAGE: DISCONNECT] Client closed SSE stream connection.`);
    }
  });

  function sendSSE(event: string, data: unknown) {
    if (!isClientConnected || res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
    } catch {
      isClientConnected = false;
    }
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

    // STAGE 2: PLANNING
    console.log(`[STAGE 2: PLANNING] Starting intent routing and tool execution...`);
    const planStartTime = Date.now();
    const toolEvents: import('./types').ToolEvent[] = [];
    const plannerResult = await runPlanner(message, sessionId, userId, (event) => {
      toolEvents.push(event);
      sendSSE('tool_event', event);
    });
    console.log(`[STAGE 2: PLANNING COMPLETE] Finished in ${Date.now() - planStartTime}ms`);
    console.log(`  -> Search results: ${plannerResult.searchResults.length}`);
    console.log(`  -> Recalled facts: ${plannerResult.recalledFacts.length}`);
    console.log(`  -> History matches: ${plannerResult.historyMatches.length}`);
    console.log('----------------------------------------------------------------');

    // STAGE 3: SYNTHESIS
    console.log(`[STAGE 3: SYNTHESIS STREAMING] Starting LLM synthesis with context...`);
    const synthStartTime = Date.now();
    let firstTokenTime: number | null = null;
    let tokenCount = 0;

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
        if (firstTokenTime === null) {
          firstTokenTime = Date.now();
          console.log(`[STAGE 3: FIRST TOKEN] Emitted first token in ${firstTokenTime - synthStartTime}ms from synthesis start`);
        }
        tokenCount++;
        fullAnswer += chunk.token;
        sendSSE('token', { token: chunk.token });
      }
      if (chunk.facts !== undefined) {
        extractedFacts = chunk.facts;
      }
    }
    console.log(`[STAGE 3: SYNTHESIS COMPLETE] Streamed ${tokenCount} tokens (${fullAnswer.length} chars) in ${Date.now() - synthStartTime}ms`);
    console.log('----------------------------------------------------------------');

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

    // STAGE 4: FACT EXTRACTION
    console.log(`[STAGE 4: FACT EXTRACTION] Parsed ${extractedFacts.length} candidate facts from response`);
    const qualifiedFacts = extractedFacts.filter(f => f.importance >= 0.6);
    console.log(`  -> Qualified persistent facts (importance >= 0.6): ${qualifiedFacts.length}`);

    // STAGE 5: EMBEDDING & VECTOR STORAGE
    const storedEntities: string[] = [];
    if (qualifiedFacts.length > 0) {
      console.log('----------------------------------------------------------------');
      console.log(`[STAGE 5: EMBEDDING & STORAGE] Generating vector embeddings and saving facts...`);
      const embedStartTime = Date.now();
      for (const fact of qualifiedFacts) {
        try {
          const t0 = Date.now();
          console.log(`  -> [EMBEDDING] Embedding "${fact.entity}: ${fact.claim}"...`);
          const embedding = await embedText(`${fact.entity}: ${fact.claim}`);
          console.log(`  -> [EMBEDDING COMPLETE] Dimension: ${embedding.length} (${Date.now() - t0}ms)`);
          upsertFact(userId, fact, embedding);
          console.log(`  -> [STORAGE] Fact for entity "${fact.entity}" stored in SQLite.`);
          storedEntities.push(fact.entity);
        } catch (err) {
          console.error('[facts] Failed to embed/store fact:', err);
        }
      }
      console.log(`[STAGE 5: EMBEDDING & STORAGE COMPLETE] Stored ${storedEntities.length} fact(s) in ${Date.now() - embedStartTime}ms`);
    } else {
      console.log(`[STAGE 5: EMBEDDING & STORAGE] Skipped (no persistent facts needed)`);
    }

    sendSSE('done', { messageId: assistantMsgId, facts_stored: storedEntities });

    console.log('================================================================');
    console.log(`[QUERY COMPLETE] Total round-trip time: ${Date.now() - queryStartTime}ms`);
    console.log('================================================================\n');

  } catch (err: any) {
    console.error('[stream] Error in chat stream:', err);
    sendSSE('error', { message: err.message || 'Internal error processing request' });
  } finally {
    if (!res.writableEnded) {
      try { res.end(); } catch {}
    }
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
