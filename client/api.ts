const BASE = '/api';

export function getToken() {
  return localStorage.getItem('token');
}

export function getStoredUsername() {
  return localStorage.getItem('username') || 'User';
}

export function setAuth(token: string, username: string) {
  localStorage.setItem('token', token);
  localStorage.setItem('username', username);
}

export function clearAuth() {
  localStorage.removeItem('token');
  localStorage.removeItem('username');
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

export async function login(username: string, password: string) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Login failed');
  }
  return res.json();
}

export async function signup(username: string, password: string) {
  const res = await fetch(`${BASE}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Signup failed');
  }
  return res.json();
}

export async function getSessions() {
  const res = await fetch(`${BASE}/sessions`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Failed to fetch sessions');
  return res.json();
}

export async function getProfile() {
  const res = await fetch(`${BASE}/profile`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Failed to fetch profile');
  return res.json();
}

export async function getStats() {
  const res = await fetch(`${BASE}/stats`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Failed to fetch stats');
  return res.json();
}

export function streamChat(
  message: string,
  sessionId: string,
  onEvent: (e: { event: string; data: any }) => void
): () => void {
  const controller = new AbortController();

  fetch(`${BASE}/chat/stream`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ message, sessionId }),
    signal: controller.signal
  })
    .then(async (res) => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        onEvent({ event: 'error', data: { message: err.error || 'Server error' } });
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = 'message';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              onEvent({ event: currentEvent, data });
            } catch {
              // Ignore partial JSON
            }
          }
        }
      }
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        onEvent({ event: 'error', data: { message: err.message || 'Network error' } });
      }
    });

  return () => controller.abort();
}

export async function sendFeedback(messageId: number, signal: 1 | -1) {
  const res = await fetch(`${BASE}/feedback`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ messageId, signal, type: 'explicit' })
  });
  return res.ok;
}
