# Chat Agent (Live Web Search + 3-Layer Persistent Memory + RL Loop)

A production-grade AI chat agent built with **Gemini Flash**, **Tavily Search**, **Node.js/TypeScript**, **SQLite**, and **React**.

Unlike stateless chat agents that re-query blindly and forget between turns, this agent features **Gemini-optimized search queries**, **3-layer persistent memory**, **transparent real-time tool reasoning**, **per-session history loading**, **honest date recall (no hallucination)**, and a **per-user reinforcement learning feedback loop**.

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
TAVILY_API_KEY=your_tavily_api_key_here
```
*(If no API keys are provided immediately, the agent still runs and provides local mock search and fallback responses so you can inspect the full UI and database architecture).*

### 3. Run Development Server
```bash
npm run dev
```
- **Web UI**: [http://localhost:5173](http://localhost:5173) (Proxied to backend)
- **Backend API**: [http://localhost:3000](http://localhost:3000)

---

## Architecture Overview

For full design trade-offs, benchmarks, and rejected alternatives, read [DESIGN.md](./DESIGN.md).

```
User Message
      |
      v
+---------------------------------------+
|  STAGE 1: FAST-PATH INTENT ROUTER     |  <- Instant heuristic (0ms)
|  Detects: search / history / recall   |     No LLM call for obvious intents
+-------------------+-------------------+
                    |
                    v
+---------------------------------------+
|  STAGE 2: GEMINI QUERY OPTIMIZER      |  <- NEW: Rewrites raw user text
|  buildSearchQuery() -> dorked query   |     site:, quotes, date filters,
|  2.5s timeout -> fallback to raw      |     OR-batching for multi-entity
+-------------------+-------------------+
                    |
        +-----------+----------+
        v           v          v
    Tavily      SQLite      Gemini
    Search      15-day      Embedding
    API         History     Search
    (6h cache)  (per-user)  (cosine sim)
        |           |          |
        +-----------+----------+
                    |
                    v
+---------------------------------------+
|  STAGE 3: GEMINI SYNTHESIZER          |  <- SSE token-by-token streaming
|  - Narrates diffs (prev X -> now Y)   |     Honest when history is empty
|  - Cites sources inline [1][2]        |     (never hallucinates past convos)
|  - Extracts <FACTS> for persistence   |
+-------------------+-------------------+
                    |
                    v
+---------------------------------------+
|  STAGE 4-5: MEMORY WRITE-BACK         |
|  - Facts (importance >= 0.6)          |
|    -> SQLite + Gemini vector embed    |
|  - Per-user RL feedback loop          |
|    (thumbs up/down re-ranks weights)  |
|  - Nightly cron: 15-day history       |
|    compressed into long-term profile  |
+---------------------------------------+
```

**Stack at a glance:**

| Layer | Technology |
|-------|-----------|
| LLM | Gemini Flash (planner + synthesizer + query optimizer + embeddings) |
| Search | Tavily API · 6-hour SQLite cache · OR-batching |
| Memory | LRU cache -> 15-day SQLite history -> compressed long-term profile |
| Vector DB | SQLite + gemini-embedding-001 cosine similarity (3072-dim) |
| Auth | JWT · bcrypt · strict WHERE user_id = ? row isolation |
| Streaming | Express SSE -> React fetch ReadableStream |
| Frontend | React + Vite + react-markdown (GFM) · per-session history loading |
| Scheduler | node-cron nightly compression job |

---

## 🧪 Benchmark Question Types Tested

1. **Multi-entity comparison & staleness:**
   > *"On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"*
   - Recalls shortlisted entities from personal memory.
   - Re-searches via a single OR-batched Tavily query.
   - Diffs current search results against previously recorded claims.

2. **Session history & date recall:**
   > *"What did I ask you on 3 November? Is your answer still correct today?"*
   - Queries user's conversation history table for date or keyword matches.
   - Evaluates if the historical answer is still fresh or requires verification.

3. **Staleness detection on time-sensitive topics:**
   > *"Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"*
   - Recalls previously discussed hosting providers.
   - Re-verifies pricing against live Tavily search results and highlights changes.

---

## 📦 Project Structure

```
/
├── server/
│   ├── index.ts              # Express server + SSE streaming endpoints
│   ├── auth.ts               # JWT authentication & multi-user isolation
│   ├── planner.ts            # Gemini tool calling & reasoning planner
│   ├── synthesizer.ts        # Streaming answer synthesis & fact extraction
│   ├── search.ts             # Tavily Search API wrapper + 6h cache + batching
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
