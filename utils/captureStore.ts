// Content-script-side store of everything the MAIN-world interceptor has captured.
// Listens for window messages from the interceptor and indexes conversations by
// focal tweet id. Also drives active pagination (asking the interceptor to replay
// TweetDetail with the next cursor).

import type {
  Conversation,
  ContentMessage,
  GqlTemplate,
  PageMessage,
  TweetData,
} from './types';
import { collectTweets, focalIdFromUrl, ingestTweetDetail, parseTweetResult } from './xParser';

export interface FetchResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface OpResult {
  ok: boolean;
  status?: number;
  error?: string;
  json?: unknown;
}

const conversations = new Map<string, Conversation>();
// Posts seen per author handle (from passively-captured UserTweets responses).
const profilePosts = new Map<string, TweetData[]>();
const pendingFetches = new Map<number, (r: FetchResult) => void>();
const pendingOps = new Map<number, (r: OpResult) => void>();
let fetchSeq = 0;

const TEMPLATE_KEY = 'gqlTemplates';

/** True while the extension context is still alive (false after a reload). */
function extValid(): boolean {
  try {
    return Boolean(browser.runtime?.id);
  } catch {
    return false;
  }
}

function getOrCreate(id: string): Conversation {
  let conv = conversations.get(id);
  if (!conv) {
    conv = { main: null, replies: new Map(), bottomCursor: null };
    conversations.set(id, conv);
  }
  return conv;
}

export function initCaptureStore(): void {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) return;
    const msg = e.data as PageMessage;
    if (!msg || msg.source !== 'cgx-page') return;

    if (msg.type === 'capture') {
      try {
        ingestCapture(msg.op, msg.url, msg.json);
      } catch (err) {
        console.warn('[claude-for-x] failed to parse captured response', err);
      }
    } else if (msg.type === 'gql-template') {
      persistTemplate(msg.op, msg.template);
    } else if (msg.type === 'fetch-more-result') {
      const resolve = pendingFetches.get(msg.requestId);
      if (resolve) {
        pendingFetches.delete(msg.requestId);
        resolve({ ok: msg.ok, status: msg.status, error: msg.error });
      }
    } else if (msg.type === 'op-result') {
      const resolve = pendingOps.get(msg.requestId);
      if (resolve) {
        pendingOps.delete(msg.requestId);
        resolve({ ok: msg.ok, status: msg.status, error: msg.error, json: msg.json });
      }
    }
  });

  // Tell the interceptor we're listening so it can flush anything it buffered
  // before this script attached.
  post({ source: 'cgx-content', type: 'ready' });

  // Hand the interceptor every query template we saved in a previous session.
  if (extValid()) {
    browser.storage.local
      .get(TEMPLATE_KEY)
      .then((stored) => {
        const templates = (stored[TEMPLATE_KEY] as Record<string, GqlTemplate>) ?? {};
        if (Object.keys(templates).length) {
          post({ source: 'cgx-content', type: 'restore-templates', templates });
        }
      })
      .catch(() => {});
  }
}

// Only the operations we actually replay are worth persisting.
const PERSIST_OPS = new Set([
  'TweetDetail',
  'SearchTimeline',
  'UserTweets',
  'UserByScreenName',
]);

/** Merge a freshly-seen template into persisted storage (only ops we replay). */
function persistTemplate(op: string, template: GqlTemplate): void {
  if (!PERSIST_OPS.has(op) || !extValid()) return;
  browser.storage.local
    .get(TEMPLATE_KEY)
    .then((stored) => {
      const map = (stored[TEMPLATE_KEY] as Record<string, GqlTemplate>) ?? {};
      map[op] = template;
      return browser.storage.local.set({ [TEMPLATE_KEY]: map });
    })
    .catch(() => {});
}

function post(msg: ContentMessage): void {
  window.postMessage(msg, '*');
}

function ingestCapture(op: string, url: string, json: unknown): void {
  if (op === 'TweetDetail') {
    const focalId = focalIdFromUrl(url);
    if (!focalId) return;
    ingestTweetDetail(getOrCreate(focalId), focalId, json);
  } else if (op === 'TweetResultByRestId') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = parseTweetResult((json as any)?.data?.tweetResult?.result);
    if (t?.id) getOrCreate(t.id).main = t;
  } else if (op === 'UserTweets') {
    // Accumulate the author's posts so profile summaries get the full set X
    // loaded (and more as the user scrolls), keyed by handle.
    for (const t of collectTweets(json, 80)) {
      if (!t.handle || !t.id) continue;
      const key = t.handle.toLowerCase();
      const arr = profilePosts.get(key) ?? [];
      if (!arr.some((x) => x.id === t.id)) arr.push(t);
      profilePosts.set(key, arr);
    }
  }
}

/** Posts captured for a given handle (from the user's profile browsing). */
export function getProfilePosts(handle: string): TweetData[] {
  return profilePosts.get(handle.toLowerCase()) ?? [];
}

export function getConversation(tweetId: string): Conversation | undefined {
  return conversations.get(tweetId);
}

/** Find a tweet anywhere in the store — as a focal tweet or as someone's reply. */
export function findTweet(tweetId: string): TweetData | null {
  const own = conversations.get(tweetId);
  if (own?.main) return own.main;
  for (const conv of conversations.values()) {
    const r = conv.replies.get(tweetId);
    if (r) return r;
  }
  return null;
}

/** Messages to the interceptor that expect a fetch-more-result ack. */
type RoundtripMessage =
  | { source: 'cgx-content'; type: 'fetch-more'; cursor: string; requestId: number }
  | { source: 'cgx-content'; type: 'fetch-detail'; tweetId: string; requestId: number };

/** Ask the interceptor to replay TweetDetail with the given cursor. */
function fetchMoreReplies(cursor: string): Promise<boolean> {
  return roundtrip((requestId) => ({
    source: 'cgx-content',
    type: 'fetch-more',
    cursor,
    requestId,
  })).then((r) => r.ok);
}

/**
 * Ask the interceptor to build a fresh TweetDetail request for this tweet id
 * (works even when the user never opened the tweet — e.g. from the timeline).
 * On success the conversation is ingested under `tweetId`.
 */
export function fetchDetail(tweetId: string): Promise<FetchResult> {
  return roundtrip((requestId) => ({
    source: 'cgx-content',
    type: 'fetch-detail',
    tweetId,
    requestId,
  }));
}

/** Replay an arbitrary read operation (SearchTimeline, UserTweets, …) and get raw JSON. */
export function runOp(op: string, variables: Record<string, unknown>): Promise<OpResult> {
  return new Promise((resolve) => {
    const requestId = ++fetchSeq;
    pendingOps.set(requestId, resolve);
    post({ source: 'cgx-content', type: 'run-op', op, variables, requestId });
    setTimeout(() => {
      if (pendingOps.delete(requestId)) resolve({ ok: false, error: 'timeout' });
    }, 15_000);
  });
}

/** Forget a cached query template (memory + storage) after it goes stale. */
export async function clearTemplate(op = 'TweetDetail'): Promise<void> {
  post({ source: 'cgx-content', type: 'clear-template', op });
  if (!extValid()) return;
  try {
    const stored = await browser.storage.local.get(TEMPLATE_KEY);
    const map = (stored[TEMPLATE_KEY] as Record<string, GqlTemplate>) ?? {};
    delete map[op];
    await browser.storage.local.set({ [TEMPLATE_KEY]: map });
  } catch {
    // ignore
  }
}

/** Send a request to the interceptor and resolve when its ack comes back. */
function roundtrip(build: (requestId: number) => RoundtripMessage): Promise<FetchResult> {
  return new Promise((resolve) => {
    const requestId = ++fetchSeq;
    pendingFetches.set(requestId, resolve);
    post(build(requestId));
    // Don't hang the UI if the response never comes back.
    setTimeout(() => {
      if (pendingFetches.delete(requestId)) resolve({ ok: false, error: 'timeout' });
    }, 12_000);
  });
}

/**
 * Actively paginate until we have `target` replies, there are no more pages,
 * or we hit the round limit. The replayed responses flow back through the
 * normal capture path, so `conv` updates as a side effect.
 */
export async function ensureReplies(
  conv: Conversation,
  target: number,
  onProgress?: (count: number) => void,
): Promise<void> {
  let rounds = 0;
  while (conv.bottomCursor && conv.replies.size < target && rounds < 4) {
    onProgress?.(conv.replies.size);
    const cursor = conv.bottomCursor;
    // Clear before fetching — the response sets a fresh cursor if more pages exist,
    // which also guarantees we never refetch the same page forever.
    conv.bottomCursor = null;
    const ok = await fetchMoreReplies(cursor);
    if (!ok) break;
    rounds++;
  }
}
