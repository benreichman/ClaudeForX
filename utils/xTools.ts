// Content-script side: executes the X "tools" Claude can call, by replaying X's
// own GraphQL read operations through the interceptor (SearchTimeline, UserTweets,
// TweetDetail) using the user's live session. Results are formatted as compact
// text for the model. All errors are returned as readable strings so Claude can
// relay them rather than crashing the turn.

import { fetchDetail, getConversation, runOp } from './captureStore';
import { collectTweets, findUserId } from './xParser';
import type { ToolCard, ToolTweet, TweetData } from './types';

const MAX_RESULTS = 18;

/** Result of running a client tool: text for Claude + a card for the panel. */
export interface ToolRun {
  content: string;
  card: ToolCard;
}

export async function executeTool(name: string, rawInput: unknown): Promise<ToolRun> {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'search_x':
        return await searchX(String(input.query ?? ''), normalizeProduct(input.product));
      case 'get_user_posts':
        return await getUserPosts(String(input.handle ?? ''));
      case 'get_tweet':
        return await getTweet(String(input.id_or_url ?? ''));
      default:
        return { content: `Unknown tool: ${name}`, card: { kind: 'x', label: name, tweets: [], note: 'unknown tool' } };
    }
  } catch (err) {
    const msg = `Tool "${name}" failed: ${(err as Error).message ?? String(err)}`;
    return { content: msg, card: { kind: 'x', label: name, tweets: [], note: msg } };
  }
}

function toToolTweet(t: TweetData): ToolTweet {
  return {
    handle: t.handle,
    text: t.text.length > 240 ? `${t.text.slice(0, 240)}…` : t.text,
    url: t.handle && t.id ? `https://x.com/${t.handle}/status/${t.id}` : '',
    likes: t.likes,
  };
}

function normalizeProduct(p: unknown): 'Top' | 'Latest' {
  return String(p ?? 'Top').toLowerCase() === 'latest' ? 'Latest' : 'Top';
}

async function searchX(query: string, product: 'Top' | 'Latest'): Promise<ToolRun> {
  const label = 'Searched X';
  if (!query.trim()) {
    return { content: 'No search query was provided.', card: { kind: 'x', label, tweets: [], note: 'no query' } };
  }
  const res = await runOp('SearchTimeline', {
    rawQuery: query,
    product,
    count: 20,
    querySource: 'typed_query',
    cursor: undefined,
  });
  const tweets = collectTweets(res.json, MAX_RESULTS);
  if (!res.ok) {
    const note =
      res.status === 404 || res.status === 400
        ? 'X search cache is stale — run a search on X once, then try again.'
        : res.error?.includes('template')
          ? "X search isn't enabled yet — run a search on X once, then ask again."
          : `Couldn't search X (${res.status ?? 'no response'}).`;
    return { content: note, card: { kind: 'x', label, query, tweets: [], note } };
  }
  if (!tweets.length) {
    return { content: `No posts found for "${query}".`, card: { kind: 'x', label, query, tweets: [], note: 'no results' } };
  }
  return {
    content: `Search results for "${query}" (${product}):\n\n${formatTweets(tweets)}`,
    card: { kind: 'x', label, query, tweets: tweets.map(toToolTweet) },
  };
}

async function getUserPosts(handleRaw: string): Promise<ToolRun> {
  const handle = handleRaw.replace(/^@/, '').trim();
  const label = `@${handle || '?'} · posts`;
  if (!handle) {
    return { content: 'No handle was provided.', card: { kind: 'x', label, tweets: [], note: 'no handle' } };
  }
  const userRes = await runOp('UserByScreenName', { screen_name: handle });
  if (!userRes.ok) {
    const note = userRes.error?.includes('template')
      ? 'Visit any profile on X once to enable this, then ask again.'
      : `Couldn't look up @${handle} (${userRes.status ?? 'no response'}).`;
    return { content: note, card: { kind: 'x', label, tweets: [], note } };
  }
  const userId = findUserId(userRes.json);
  if (!userId) {
    const note = `Couldn't find a user with the handle @${handle}.`;
    return { content: note, card: { kind: 'x', label, tweets: [], note } };
  }
  const postsRes = await runOp('UserTweets', { userId, count: 20, cursor: undefined });
  const tweets = collectTweets(postsRes.json, MAX_RESULTS);
  if (!postsRes.ok || !tweets.length) {
    const note = !postsRes.ok
      ? `Couldn't load @${handle}'s posts (${postsRes.status ?? 'no response'}).`
      : `@${handle} has no visible recent posts.`;
    return { content: note, card: { kind: 'x', label, tweets: [], note } };
  }
  return {
    content: `Recent posts from @${handle}:\n\n${formatTweets(tweets)}`,
    card: { kind: 'x', label, tweets: tweets.map(toToolTweet) },
  };
}

async function getTweet(idOrUrl: string): Promise<ToolRun> {
  const label = 'Fetched post';
  const id = extractTweetId(idOrUrl);
  if (!id) {
    const note = `Couldn't parse a tweet id from "${idOrUrl}".`;
    return { content: note, card: { kind: 'x', label, tweets: [], note } };
  }
  const res = await fetchDetail(id);
  const conv = getConversation(id);
  if (!res.ok || !conv?.main) {
    const note = "Couldn't fetch that tweet. Open any tweet on X once to refresh.";
    return { content: note, card: { kind: 'x', label, tweets: [], note } };
  }
  const replies = [...conv.replies.values()].slice(0, 10);
  const content = [`Post:\n${formatTweet(conv.main)}`];
  if (replies.length) content.push(`\nTop replies:\n${formatTweets(replies)}`);
  return {
    content: content.join('\n'),
    card: { kind: 'x', label, tweets: [conv.main, ...replies].map(toToolTweet) },
  };
}

function extractTweetId(s: string): string | null {
  const m = s.match(/status\/(\d+)/) ?? s.match(/^\s*(\d{5,25})\s*$/);
  return m ? m[1] : null;
}

// ---- formatting ----

function fmtNum(n: number | string | null): string {
  const v = typeof n === 'string' ? parseInt(n, 10) : n;
  if (v == null || Number.isNaN(v)) return '?';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function formatTweet(t: TweetData): string {
  const lines: string[] = [];
  lines.push(`@${t.handle}${t.name ? ` (${t.name})` : ''}${t.createdAt ? ` · ${t.createdAt}` : ''}`);
  lines.push(t.text || '(no text)');
  if (t.media.length) {
    lines.push(`[${t.media.map((m) => m.type).join(', ')}]`);
  }
  const stats =
    t.likes != null
      ? `❤ ${fmtNum(t.likes)} · 🔁 ${fmtNum(t.retweets)} · 💬 ${fmtNum(t.replyCount)}`
      : '';
  const url = t.handle && t.id ? `https://x.com/${t.handle}/status/${t.id}` : '';
  lines.push([stats, url].filter(Boolean).join('  '));
  return lines.join('\n');
}

function formatTweets(tweets: TweetData[]): string {
  return tweets.map((t, i) => `${i + 1}. ${formatTweet(t)}`).join('\n\n');
}
