# Antigravity Chat Agent (Web Search + 3-Layer Persistent Memory + RL Loop)

A chat agent built with **Gemini**, **Brave Search**, **Node.js/TypeScript**, **SQLite**, and **React**.

Unlike traditional stateless chat agents that re-query the web blindly and forget everything between turns, this agent features **3-Layer Memory**, **transparent real-time tool reasoning**, **smart query batching with 6-hour caching**, and a **per-user reinforcement learning feedback loop**.

---

## ⚡ Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Create `.env` from `.env.example`:
```bash
cp .env.example .env
```
Add your API keys in `.env`:
```env
GEMINI_API_KEY=your_gemini_api_key_here
BRAVE_API_KEY=your_brave_search_api_key_here
```
*(If no API keys are provided immediately, the agent still runs and provides local mock search and fallback responses so you can inspect the full UI and database architecture).*

### 3. Run Development Server
```bash
npm run dev
```
- **Web UI**: [http://localhost:5173](http://localhost:5173) (Proxied to backend)
- **Backend API**: [http://localhost:3000](http://localhost:3000)

---

## 🏗️ Architecture Overview

For full design trade-offs, benchmarks, and rejected alternatives, read [DESIGN.md](./DESIGN.md).

```
User Message
     │
     ▼
Planner (Gemini Flash)
  ├─ Reads: Active session turns (LRU Cache) + Long-term Profile + Clock
  ├─ Decides: recall / search / verify-stale / compare / converse
  │
  ├── [recall]       → Fact Store (SQLite + Cosine Similarity over Embeddings)
  ├── [search]       → Brave Search API (6h cache, OR-batching)
  ├── [verify-stale] → Brave (re-searches entity, diffs against stored facts)
  └── [compare]      → Batched Brave Search ("A OR B OR C pricing")
     │
     ▼
Synthesizer (Gemini Flash / Pro)
  ├─ Streams token-by-token over SSE
  ├─ Narrates diffs explicitly ("Previously $49/mo → now $65/mo")
  └─ Extracts high-value facts (importance ≥ 0.6) into vector fact store
     │
     ▼
Per-User Reinforcement Learning Loop
  └─ User feedback (👍/👎, corrections) re-ranks entity weights for that user only
```

---

## 🧪 Benchmark Question Types Tested

1. **Multi-entity comparison & staleness:**
   > *"On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"*
   - Recalls shortlisted entities from personal memory.
   - Re-searches via a single OR-batched Brave query.
   - Diffs current search results against previously recorded claims.

2. **Session history & date recall:**
   > *"What did I ask you on 3 November? Is your answer still correct today?"*
   - Queries user's conversation history table for date or keyword matches.
   - Evaluates if the historical answer is still fresh or requires verification.

3. **Staleness detection on time-sensitive topics:**
   > *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"*
   - Recalls previously discussed hosting providers.
   - Re-verifies pricing against live Brave search results and highlights changes.

---

## 📦 Project Structure

```
/
├── server/
│   ├── index.ts              # Express server + SSE streaming endpoints
│   ├── auth.ts               # JWT authentication & multi-user isolation
│   ├── planner.ts            # Gemini tool calling & reasoning planner
│   ├── synthesizer.ts        # Streaming answer synthesis & fact extraction
│   ├── search.ts             # Brave Search API wrapper + 6h cache + batching
│   ├── embeddings.ts         # text-embedding-004 cosine similarity
│   ├── memory/
│   │   ├── history.ts        # 15-day conversation history + LRU session cache
│   │   ├── facts.ts          # Per-user fact store + vector embeddings
│   │   ├── feedback.ts       # Per-user RL reward signals & weight re-scoring
│   │   └── compression.ts    # Nightly 15-day rollup into long-term profile
│   └── db/
│       ├── index.ts          # SQLite connector (node:sqlite / better-sqlite3)
│       └── schema.sql        # Tables with strict user_id scoping
├── client/
│   ├── pages/
│   │   ├── Auth.tsx          # Login & Signup screen
│   │   └── Chat.tsx          # Chat screen with live tool reasoning & memory drawer
│   ├── api.ts                # Frontend API client
│   └── main.tsx              # React entrypoint
├── DESIGN.md                 # 1-page design document for evaluators
├── .env.example              # Template for API keys
└── package.json
```
