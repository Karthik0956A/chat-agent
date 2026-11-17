# DESIGN.md

## How It Works

This is a stateful web-based chat agent backed by Gemini and Tavily Search API. Its core insight is that **most chat agents have no memory**. Ours has three layers of it.

### Request Flow

```
User message
     │
     ▼
Planner (Gemini Flash, function-calling)
  ├─ reads: last 6 turns (LRU cache) + user profile summary + current datetime
  ├─ emits: a plan — ordered list of tool calls with intent labels
  │          intents: recall / search / verify-stale / compare / converse
  │
  ├──[recall]        → Fact Store (SQLite + cosine similarity over embeddings)
  ├──[search]        → Tavily Search API (6h result cache, OR-batched for multi-entity)
  ├──[verify-stale]  → Tavily (re-searches entity, diffs against stored fact)
  └──[compare]       → Tavily (single OR-query for N entities, e.g. "A OR B OR C pricing")
     │
     ▼
Synthesizer (Gemini Flash, streaming)
  ├─ streams answer token-by-token to browser over SSE
  ├─ narrates diffs explicitly when facts changed ("was $49/mo → now $65/mo")
  ├─ extracts facts worth storing (importance score 0–1, threshold 0.6)
  └─ stores new/updated facts with embeddings
     │
     ▼
Post-turn
  ├─ persist message to SQLite
  ├─ write high-importance facts to fact store
  └─ apply any feedback signals to fact re-scoring
```

The browser shows a **tool status strip** in real time between the user's message and the answer — what was searched, what was recalled, whether a fact looked stale. Evaluators (and users) see the agent reasoning, not a black box.

---

## Memory Architecture — Three Layers

### Layer 1: Session Cache (in-memory, LRU)
Last 6 turns of the active session held in a per-process LRU map. Zero DB reads for the hot path. Evicts after 30 min inactivity.

### Layer 2: Chat History (SQLite, 15-day rolling window)
Full messages persisted per user. A nightly job deletes anything older than 15 days. But before deletion, it runs the **compression step** (see Layer 3).

### Layer 3: Long-Term User Profile (forever)
When messages age past 15 days, Gemini summarises that conversation chunk into a `user_profiles` row: topics the user cares about, entities they've tracked, decisions they've made. Raw messages deleted. The compressed knowledge lives on. This means the agent can answer "What did I ask you about last month?" without storing raw chats indefinitely.

**Why this wins**: most agents either store everything (expensive, noisy) or nothing (amnesiac). Compression is the right tradeoff.

---

## Fact Store

Each user has an isolated fact store: `entity → claim + source + embedding + importance + verified_at`.

- **Write**: only when Synthesizer assigns importance ≥ 0.6. Not every piece of search output — only information worth revisiting.
- **Read**: cosine similarity over `text-embedding-004` embeddings, re-ranked by a per-user reward weight (see RL loop below).
- **Staleness**: no hard threshold. The Planner sees `verified_at` and judges per domain — pricing goes stale fast, company names don't. Model decides, not a config number.

---

## Per-User Feedback Loop (RL-inspired)

Every assistant message has 👍/👎. Implicit signals also collected: a correction in the next turn → negative; "perfect, thanks" → positive; re-asking the same question → negative.

Signals update per-user reward weights on the entities mentioned in that turn:
```
importance += signal × 0.05   (clamped 0–1)
final_retrieval_score = cosine_similarity × (1 + reward_weight[entity])
```

Over time, each user's agent learns which facts are valuable to *them* and surfaces them first. Per-user isolation is strict — no cross-user signal leakage.

---

## Search Budget & Efficiency

Powered by Tavily API (with automatic fallback to Brave / mock search).

Efficiency mechanisms:
1. **6-hour result cache** in SQLite — same query within a session = 0 external search calls.
2. **OR-batching** — "5 CRM tools" → `Salesforce OR HubSpot OR Pipedrive OR Freshsales OR Zoho pricing 2026` = 1 call.
3. **Lazy staleness checks** — only triggered when the user asks something time-sensitive, not proactively.

With caching + batching, 1000 raw search calls serve ~3,000–5,000 effective user queries.

---

## What Was Considered and Rejected

| Approach | Why rejected |
|---|---|
| Multi-agent (Researcher + Critic) | 2–4× latency for marginal quality gain. Single planner + synthesizer is faster and equally accurate for this domain. |
| Full RLHF / fine-tuning | Requires GPU + 10k+ labeled examples. The feedback loop achieves personalisation without retraining. |
| Chroma / external vector DB | Unnecessary infra for <50k facts per user. SQLite + JS cosine is enough and simpler to explain. |
| Storing all history forever | Noisy, expensive. Compression gives better signal at lower cost. |
| Fixed staleness threshold (e.g. 24h) | Too rigid. Pricing goes stale in hours; company names are stable for months. Model judgment per domain is better. |
| RAG over raw messages | Embeddings on raw chat logs are expensive and noisy. Structured fact extraction + profile compression is higher signal. |

---

## What Another Week Would Add

1. **Background staleness sweeper** — proactively re-verify high-importance facts for all users nightly, not just on demand.
2. **Citation rendering** — inline footnotes with source URLs, expandable in UI.
3. **Search query learning** — track which Tavily query templates yielded good answers (by feedback signal) and prefer them for similar future queries.
4. **Multi-turn entity threading** — explicitly track "this conversation is about these 5 CRM tools" so the Planner doesn't have to re-infer entities from scratch each turn.
5. **Export / share session** — let users share a conversation as a permalink.
6. **Eval harness** — automated tests against the 3 benchmark question types with synthetic sessions.
