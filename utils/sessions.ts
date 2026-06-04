// Persistent chat sessions, stored in extension local storage. Images are
// stripped before saving (they're large base64 and only needed live); tool
// cards + sources are small and kept so history renders faithfully.

import type { ToolCard, WebSource } from './types';

export interface StoredTurn {
  role: 'user' | 'assistant';
  content: string;
  display: string;
  tools?: ToolCard[];
  sources?: WebSource[];
}

export interface ChatSession {
  id: string;
  title: string;
  mode: 'tweet' | 'general';
  createdAt: number;
  updatedAt: number;
  turns: StoredTurn[];
}

const KEY = 'sessions';
const MAX_SESSIONS = 40;

function extValid(): boolean {
  try {
    return Boolean(browser.runtime?.id);
  } catch {
    return false;
  }
}

export function newSessionId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  }
}

export function titleFromTurns(turns: StoredTurn[]): string {
  const firstUser = turns.find((t) => t.role === 'user');
  const raw = (firstUser?.display || 'New chat').trim().replace(/\s+/g, ' ');
  return raw.length > 48 ? `${raw.slice(0, 48)}…` : raw;
}

export async function listSessions(): Promise<ChatSession[]> {
  if (!extValid()) return [];
  try {
    const stored = await browser.storage.local.get(KEY);
    const list = (stored[KEY] as ChatSession[]) ?? [];
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** Insert or update a session (by id), newest first, capped to MAX_SESSIONS. */
export async function saveSession(session: ChatSession): Promise<void> {
  if (!extValid() || !session.turns.length) return;
  try {
    const list = await listSessions();
    const without = list.filter((s) => s.id !== session.id);
    const next = [session, ...without]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS);
    await browser.storage.local.set({ [KEY]: next });
  } catch {
    // ignore persistence failures
  }
}

export async function deleteSession(id: string): Promise<void> {
  if (!extValid()) return;
  try {
    const list = await listSessions();
    await browser.storage.local.set({ [KEY]: list.filter((s) => s.id !== id) });
  } catch {
    // ignore
  }
}
