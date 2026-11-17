import React, { useState, useEffect, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  streamChat,
  sendFeedback,
  getSessions,
  getProfile,
  getStats,
  clearAuth,
  getStoredUsername
} from '../api';

interface ToolEvent {
  type: string;
  query?: string;
  entity?: string;
  fact?: string;
  age?: string;
  resultCount?: number;
  isStale?: boolean;
}

interface ChatMessage {
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  toolEvents: ToolEvent[];
  streaming?: boolean;
  feedback?: 1 | -1;
}

const TOOL_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  search_start: { icon: '🔍', color: '#60a5fa', label: 'Searching Brave Web' },
  search_done: { icon: '🌐', color: '#34d399', label: 'Search Completed' },
  recall_start: { icon: '🧠', color: '#c084fc', label: 'Consulting Personal Memory' },
  recall_done: { icon: '📋', color: '#a78bfa', label: 'Memory Recalled' },
  verify_start: { icon: '⚠️', color: '#fbbf24', label: 'Re-verifying Stale Facts' },
  verify_done: { icon: '✅', color: '#34d399', label: 'Verification Verified' },
};

function ToolStrip({ events }: { events: ToolEvent[] }) {
  if (!events || events.length === 0) return null;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      marginBottom: '8px',
      padding: '8px 12px',
      backgroundColor: '#131722',
      border: '1px solid #232b3e',
      borderRadius: '8px',
      fontSize: '12px',
      maxWidth: '85%'
    }}>
      <div style={{ fontSize: '11px', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
        Live Agent Reasoning & Tool Actions
      </div>
      {events.map((e, idx) => {
        const conf = TOOL_CONFIG[e.type] || { icon: '⚙️', color: '#94a3b8', label: e.type };
        let detail = '';
        if (e.type === 'search_start') detail = `Query: "${e.query}"`;
        else if (e.type === 'search_done') detail = `Found ${e.resultCount ?? 0} results for "${e.query}"`;
        else if (e.type === 'recall_start') detail = `Looking up facts on: ${e.entity || e.query || 'topics'}`;
        else if (e.type === 'recall_done') detail = e.fact ? `${e.entity ? e.entity + ': ' : ''}${e.fact} ${e.age ? '(' + e.age + ')' : ''}` : 'Recalled context';
        else if (e.type === 'verify_start') detail = `Checking freshness for: "${e.query || e.entity}"`;
        else if (e.type === 'verify_done') detail = `Completed re-verification for: "${e.query || e.entity}"`;

        return (
          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#cbd5e1' }}>
            <span>{conf.icon}</span>
            <span style={{ color: conf.color, fontWeight: 500 }}>{conf.label}:</span>
            <span style={{ color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {detail}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function renderFormattedMessage(text: string) {
  const lines = text.split('\n');
  return lines.map((line, i) => {
    // Bold formatting **text**
    const parts = line.split(/(\*\*.*?\*\*)/g);
    return (
      <div key={i} style={{ minHeight: '1.2em' }}>
        {parts.map((p, j) => {
          if (p.startsWith('**') && p.endsWith('**')) {
            return <strong key={j} style={{ color: '#f8fafc', fontWeight: 600 }}>{p.slice(2, -2)}</strong>;
          }
          return p;
        })}
      </div>
    );
  });
}

export default function Chat({ onLogout }: { onLogout: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string>(() => uuidv4());
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [userProfileData, setUserProfileData] = useState<{ profile: any; facts: any[] } | null>(null);
  const [stats, setStats] = useState<{ brave_calls_this_month: number } | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const username = getStoredUsername();

  const loadSessionsAndStats = useCallback(async () => {
    try {
      const [sList, st] = await Promise.all([getSessions(), getStats()]);
      setSessions(sList || []);
      setStats(st);
    } catch (err) {
      console.warn('Failed to load initial data:', err);
    }
  }, []);

  useEffect(() => {
    loadSessionsAndStats();
  }, [loadSessionsAndStats]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const openProfileModal = async () => {
    try {
      const data = await getProfile();
      setUserProfileData(data);
      setShowProfileModal(true);
    } catch (err) {
      console.error(err);
    }
  };

  const startNewChat = () => {
    if (isStreaming) return;
    setSessionId(uuidv4());
    setMessages([]);
  };

  const selectSession = (sid: string) => {
    if (isStreaming || sid === sessionId) return;
    setSessionId(sid);
    setMessages([
      {
        role: 'assistant',
        content: `Resumed session ${sid.slice(0, 8)}... Your conversation history and extracted facts from this thread are loaded in memory.`,
        toolEvents: []
      }
    ]);
  };

  const handleFeedbackClick = async (msgIndex: number, messageId: number | undefined, signal: 1 | -1) => {
    if (!messageId) return;
    try {
      await sendFeedback(messageId, signal);
      setMessages((prev) => {
        const next = [...prev];
        next[msgIndex] = { ...next[msgIndex], feedback: signal };
        return next;
      });
    } catch (err) {
      console.error('Feedback failed:', err);
    }
  };

  const sendMessage = useCallback(
    (customText?: string) => {
      const textToSend = (customText || input).trim();
      if (!textToSend || isStreaming) return;

      const userMsg: ChatMessage = { role: 'user', content: textToSend, toolEvents: [] };
      setMessages((prev) => [...prev, userMsg]);
      setInput('');
      setIsStreaming(true);

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: '',
        toolEvents: [],
        streaming: true
      };
      setMessages((prev) => [...prev, assistantMsg]);

      streamChat(textToSend, sessionId, ({ event, data }) => {
        if (event === 'tool_event') {
          setMessages((prev) => {
            const next = [...prev];
            const last = { ...next[next.length - 1] };
            last.toolEvents = [...last.toolEvents, data as ToolEvent];
            next[next.length - 1] = last;
            return next;
          });
        } else if (event === 'token') {
          setMessages((prev) => {
            const next = [...prev];
            const last = { ...next[next.length - 1] };
            last.content += data.token || '';
            next[next.length - 1] = last;
            return next;
          });
        } else if (event === 'done') {
          setMessages((prev) => {
            const next = [...prev];
            const last = { ...next[next.length - 1] };
            last.streaming = false;
            last.id = data.messageId;
            next[next.length - 1] = last;
            return next;
          });
          setIsStreaming(false);
          loadSessionsAndStats();
        } else if (event === 'error') {
          setMessages((prev) => {
            const next = [...prev];
            const last = { ...next[next.length - 1] };
            last.content += `\n\n*(Error: ${data.message || 'Unknown error'})*`;
            last.streaming = false;
            next[next.length - 1] = last;
            return next;
          });
          setIsStreaming(false);
        }
      });
    },
    [input, sessionId, isStreaming, loadSessionsAndStats]
  );

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      {/* Sidebar */}
      <div style={{
        width: '280px',
        backgroundColor: '#12151b',
        borderRight: '1px solid #1e2430',
        display: 'flex',
        flexDirection: 'column',
        padding: '16px',
        flexShrink: 0
      }}>
        {/* App Title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
          <div style={{
            width: '36px',
            height: '36px',
            borderRadius: '10px',
            background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 'bold',
            fontSize: '18px'
          }}>
            ⚡
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '15px', color: '#f8fafc' }}>Antigravity Agent</div>
            <div style={{ fontSize: '11px', color: '#64748b' }}>Brave Search & Memory</div>
          </div>
        </div>

        {/* New Chat Button */}
        <button
          onClick={startNewChat}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            width: '100%',
            padding: '10px',
            borderRadius: '8px',
            backgroundColor: '#1e2430',
            border: '1px solid #2e3646',
            color: '#f8fafc',
            fontWeight: 600,
            fontSize: '13px',
            cursor: 'pointer',
            marginBottom: '16px',
            transition: 'background-color 0.2s'
          }}
        >
          <span>＋</span> New Conversation
        </button>

        {/* Sessions List */}
        <div style={{ fontSize: '11px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.5px' }}>
          Recent Conversations (15-day window)
        </div>
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {sessions.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#475569', fontStyle: 'italic', padding: '8px' }}>
              No previous sessions yet
            </div>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                onClick={() => selectSession(s.id)}
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  fontSize: '13px',
                  cursor: 'pointer',
                  backgroundColor: s.id === sessionId ? '#1f2533' : 'transparent',
                  color: s.id === sessionId ? '#f8fafc' : '#94a3b8',
                  border: s.id === sessionId ? '1px solid #3b455b' : '1px solid transparent',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                💬 {s.first_message ? s.first_message.slice(0, 32) : 'Conversation ' + s.id.slice(0, 6)}
              </div>
            ))
          )}
        </div>

        {/* Memory & Profile Button */}
        <button
          onClick={openProfileModal}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '10px 12px',
            backgroundColor: '#1a1f2c',
            border: '1px solid #2d3748',
            borderRadius: '8px',
            color: '#a5b4fc',
            fontSize: '12px',
            fontWeight: 500,
            cursor: 'pointer',
            marginBottom: '10px'
          }}
        >
          <span>🧠</span> View Memory & Fact Store
        </button>

        {/* User bar */}
        <div style={{
          borderTop: '1px solid #1e2430',
          paddingTop: '12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden' }}>
            <div style={{
              width: '28px',
              height: '28px',
              borderRadius: '50%',
              backgroundColor: '#4f46e5',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '12px',
              fontWeight: 700,
              color: 'white',
              flexShrink: 0
            }}>
              {username[0]?.toUpperCase() || 'U'}
            </div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {username}
            </div>
          </div>
          <button
            onClick={() => {
              clearAuth();
              onLogout();
            }}
            title="Log out"
            style={{
              background: 'none',
              border: 'none',
              color: '#64748b',
              fontSize: '13px',
              cursor: 'pointer',
              padding: '4px'
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Main Chat Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', backgroundColor: '#0d0f12' }}>
        {/* Top Header */}
        <div style={{
          height: '56px',
          borderBottom: '1px solid #1e2430',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          backgroundColor: '#101319'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '14px', fontWeight: 600, color: '#f8fafc' }}>
              Active Session
            </span>
            <span style={{ fontSize: '12px', color: '#64748b', fontFamily: 'monospace' }}>
              {sessionId.slice(0, 8)}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '12px' }}>
            <div style={{
              padding: '4px 10px',
              borderRadius: '20px',
              backgroundColor: '#1e293b',
              color: '#94a3b8',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}>
              <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#22c55e' }}></span>
              Brave Search Calls: <strong style={{ color: '#f8fafc' }}>{stats?.brave_calls_this_month ?? 0}</strong> / 1000
            </div>
          </div>
        </div>

        {/* Message Container */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px' }}>
          {messages.length === 0 ? (
            <div style={{
              maxWidth: '680px',
              margin: '60px auto 0',
              textAlign: 'center'
            }}>
              <div style={{
                display: 'inline-block',
                width: '64px',
                height: '64px',
                borderRadius: '16px',
                background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
                fontSize: '32px',
                lineHeight: '64px',
                marginBottom: '20px'
              }}>
                ⚡
              </div>
              <h2 style={{ fontSize: '24px', fontWeight: 700, color: '#f8fafc', marginBottom: '8px' }}>
                Ask anything. I search live & remember over time.
              </h2>
              <p style={{ fontSize: '14px', color: '#94a3b8', marginBottom: '32px', lineHeight: 1.6 }}>
                Equipped with live web search, transparent reasoning status, 15-day conversation history,
                long-term memory compression, and per-user reinforcement feedback.
              </p>

              <div style={{ fontSize: '12px', fontWeight: 600, color: '#64748b', textTransform: 'uppercase', marginBottom: '12px' }}>
                Try benchmark questions:
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {[
                  'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
                  'What did I ask you on 3 November? Is your answer still correct today?',
                  'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?'
                ].map((sample, idx) => (
                  <button
                    key={idx}
                    onClick={() => sendMessage(sample)}
                    style={{
                      padding: '12px 16px',
                      backgroundColor: '#161922',
                      border: '1px solid #252c3c',
                      borderRadius: '10px',
                      color: '#cbd5e1',
                      fontSize: '13px',
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      lineHeight: 1.5
                    }}
                  >
                    💬 "{sample}"
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ maxWidth: '800px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {messages.map((msg, idx) => {
                const isUser = msg.role === 'user';
                return (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: isUser ? 'flex-end' : 'flex-start'
                    }}
                  >
                    {!isUser && <ToolStrip events={msg.toolEvents} />}

                    <div style={{
                      maxWidth: '85%',
                      padding: '14px 18px',
                      borderRadius: isUser ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                      backgroundColor: isUser ? '#4f46e5' : '#161922',
                      border: isUser ? 'none' : '1px solid #232a3b',
                      color: '#f8fafc',
                      fontSize: '14px',
                      lineHeight: 1.6,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                    }}>
                      {renderFormattedMessage(msg.content)}
                      {msg.streaming && <span style={{ opacity: 0.7, color: '#818cf8', fontWeight: 'bold' }}> ▍</span>}
                    </div>

                    {!isUser && !msg.streaming && msg.id && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', paddingLeft: '4px' }}>
                        <span style={{ fontSize: '11px', color: '#64748b' }}>Was this answer accurate?</span>
                        <button
                          onClick={() => handleFeedbackClick(idx, msg.id, 1)}
                          title="Helpful & accurate"
                          style={{
                            background: msg.feedback === 1 ? '#1e3a29' : 'none',
                            border: msg.feedback === 1 ? '1px solid #22c55e' : '1px solid #2d3748',
                            borderRadius: '4px',
                            padding: '2px 6px',
                            cursor: 'pointer',
                            fontSize: '12px'
                          }}
                        >
                          👍
                        </button>
                        <button
                          onClick={() => handleFeedbackClick(idx, msg.id, -1)}
                          title="Inaccurate or stale"
                          style={{
                            background: msg.feedback === -1 ? '#451a1a' : 'none',
                            border: msg.feedback === -1 ? '1px solid #ef4444' : '1px solid #2d3748',
                            borderRadius: '4px',
                            padding: '2px 6px',
                            cursor: 'pointer',
                            fontSize: '12px'
                          }}
                        >
                          👎
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Input Bar */}
        <div style={{
          padding: '16px 32px 24px',
          backgroundColor: '#101319',
          borderTop: '1px solid #1e2430'
        }}>
          <div style={{
            maxWidth: '800px',
            margin: '0 auto',
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-end',
            backgroundColor: '#161922',
            border: '1px solid #283042',
            borderRadius: '12px',
            padding: '8px 12px'
          }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Ask a question, compare tools, or ask about past decisions..."
              rows={Math.min(4, Math.max(1, input.split('\n').length))}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                color: '#f8fafc',
                fontSize: '14px',
                outline: 'none',
                resize: 'none',
                lineHeight: 1.5,
                fontFamily: 'inherit'
              }}
            />
            <button
              onClick={() => sendMessage()}
              disabled={isStreaming || !input.trim()}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                backgroundColor: isStreaming || !input.trim() ? '#2a3346' : '#6366f1',
                color: 'white',
                border: 'none',
                fontWeight: 600,
                fontSize: '13px',
                cursor: isStreaming || !input.trim() ? 'not-allowed' : 'pointer',
                transition: 'background-color 0.2s',
                alignSelf: 'flex-end'
              }}
            >
              Send ↵
            </button>
          </div>
          <div style={{ textAlign: 'center', fontSize: '11px', color: '#64748b', marginTop: '8px' }}>
            Enter to send • Shift + Enter for new line • Automatic facts extraction & staleness check
          </div>
        </div>
      </div>

      {/* Profile & Memory Inspector Modal */}
      {showProfileModal && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
          padding: '20px'
        }}>
          <div style={{
            backgroundColor: '#161922',
            border: '1px solid #283042',
            borderRadius: '16px',
            width: '100%',
            maxWidth: '600px',
            maxHeight: '85vh',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
          }}>
            <div style={{
              padding: '18px 24px',
              borderBottom: '1px solid #232a3b',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}>
              <h3 style={{ fontSize: '16px', fontWeight: 700, color: '#f8fafc' }}>
                🧠 Long-Term Memory & Profile Inspector
              </h3>
              <button
                onClick={() => setShowProfileModal(false)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '18px', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: '#818cf8', textTransform: 'uppercase', marginBottom: '6px' }}>
                  Layer 3: Compressed Long-Term Profile Summary
                </div>
                <div style={{
                  padding: '12px',
                  backgroundColor: '#0d0f12',
                  border: '1px solid #1e2430',
                  borderRadius: '8px',
                  fontSize: '13px',
                  color: '#cbd5e1',
                  lineHeight: 1.5
                }}>
                  {userProfileData?.profile?.summary || 'No compressed profile yet. Old conversations will be periodically distilled into your profile summary.'}
                </div>
              </div>

              <div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: '#818cf8', textTransform: 'uppercase', marginBottom: '6px' }}>
                  User Tracked Topics
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {userProfileData?.profile?.topics?.length > 0 ? (
                    userProfileData.profile.topics.map((t: string, i: number) => (
                      <span key={i} style={{ padding: '4px 8px', borderRadius: '4px', backgroundColor: '#1e2430', color: '#cbd5e1', fontSize: '12px' }}>
                        #{t}
                      </span>
                    ))
                  ) : (
                    <span style={{ fontSize: '12px', color: '#64748b' }}>No topics tracked yet</span>
                  )}
                </div>
              </div>

              <div>
                <div style={{ fontSize: '12px', fontWeight: 600, color: '#818cf8', textTransform: 'uppercase', marginBottom: '6px' }}>
                  Stored Verified Facts ({userProfileData?.facts?.length || 0})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {userProfileData?.facts && userProfileData.facts.length > 0 ? (
                    userProfileData.facts.map((f, i) => (
                      <div key={i} style={{ padding: '10px', backgroundColor: '#0d0f12', border: '1px solid #1e2430', borderRadius: '8px', fontSize: '13px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                          <strong style={{ color: '#38bdf8' }}>{f.entity}</strong>
                          <span style={{ fontSize: '11px', color: '#64748b' }}>Verified: {f.verified_at}</span>
                        </div>
                        <div style={{ color: '#cbd5e1', fontSize: '12px' }}>{f.claim}</div>
                      </div>
                    ))
                  ) : (
                    <div style={{ fontSize: '12px', color: '#64748b', fontStyle: 'italic' }}>
                      No facts stored yet. As you ask questions about tools, pricing, or decisions, important facts will automatically be stored here.
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div style={{ padding: '14px 24px', borderTop: '1px solid #232a3b', display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowProfileModal(false)}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#1e2430',
                  border: '1px solid #2e3646',
                  borderRadius: '6px',
                  color: '#f8fafc',
                  fontSize: '13px',
                  cursor: 'pointer'
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
