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
  name: 'web_search' | 'brave_search' | 'recall_facts' | 'search_history';
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

export type SSEEvent =
  | { event: 'tool_event'; data: ToolEvent }
  | { event: 'token'; data: { token: string } }
  | { event: 'done'; data: { messageId: number; facts_stored: string[] } }
  | { event: 'error'; data: { message: string } };
