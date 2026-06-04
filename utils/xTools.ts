// Content-script side: executes the X "tools" Claude can call, by replaying X's
// own GraphQL read operations through the interceptor (SearchTimeline, UserTweets,
// TweetDetail) using the user's live session. Results are formatted as compact
// text for the model. All errors are returned as readable strings so Claude can
// relay them rather than crashing the turn.

import { fetchDetail, getConversation, runOp } from './captureStore';
import { collectTweets, findUserId } from './xParser';
import type { TweetData } from './types';

const MAX_RESULTS = 18;

export async function executeTool(name: string, rawInput: unknown): Promise<string> {
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
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool "${name}" failed: ${(err as Error).message ?? String(err)}`;
  }
}

function normalizeProduct(p: unknown): 'Top' | 'Latest' {
  return String(p ?? 'Top').toLowerCase() === 'latest' ? 'Latest' : 'Top';
}

async function searchX(query: string, product: 'Top' | 'Latest'): Promise<string> {
  if (!query.trim()) return 'No search query was provided.';
  // Reset pagination/source vars so a cursor left over from the priming search
  // doesn't poison the replay.
  const res = await runOp('SearchTimeline', {
    rawQuery: query,
    product,
    count: 20,
    querySource: 'typed_query',
    cursor: undefined,
  });
  console.debug('[claude-for-x] search_x', { query, product, ok: res.ok, status: res.status, error: res.error, tweets: collectTweets(res.json, MAX_RESULTS).length });
  if (!res.ok) {
    if (res.status === 404 || res.status === 400) {
      return 'X search is primed from your own usage and the cached query is stale. Run a search on X once, then try again.';
    }
    return res.error?.includes('template')
      ? "X search isn't enabled yet — run a search on X once (so the extension can learn the request), then ask again."
      : `Couldn't search X (${res.status ?? 'no response'}).`;
  }
  const tweets = collectTweets(res.json, MAX_RESULTS);
  if (!tweets.length) return `No posts found for "${query}".`;
  return `Search results for "${query}" (${product}):\n\n${formatTweets(tweets)}`;
}

async function getUserPosts(handleRaw: string): Promise<string> {
  const handle = handleRaw.replace(/^@/, '').trim();
  if (!handle) return 'No handle was provided.';

  const userRes = await runOp('UserByScreenName', { screen_name: handle });
  if (!userRes.ok) {
    return userRes.error?.includes('template')
      ? "Fetching users isn't enabled yet — visit any profile on X once, then ask again."
      : `Couldn't look up @${handle} (${userRes.status ?? 'no response'}).`;
  }
  const userId = findUserId(userRes.json);
  if (!userId) return `Couldn't find a user with the handle @${handle}.`;

  const postsRes = await runOp('UserTweets', { userId, count: 20, cursor: undefined });
  if (!postsRes.ok) {
    return postsRes.error?.includes('template')
      ? "Fetching a user's posts isn't enabled yet — open any profile's posts on X once, then ask again."
      : `Couldn't load @${handle}'s posts (${postsRes.status ?? 'no response'}).`;
  }
  const tweets = collectTweets(postsRes.json, MAX_RESULTS);
  if (!tweets.length) return `@${handle} has no visible recent posts.`;
  return `Recent posts from @${handle}:\n\n${formatTweets(tweets)}`;
}

async function getTweet(idOrUrl: string): Promise<string> {
  const id = extractTweetId(idOrUrl);
  if (!id) return `Couldn't parse a tweet id from "${idOrUrl}".`;

  const res = await fetchDetail(id);
  if (!res.ok) {
    return "Couldn't fetch that tweet. If this keeps happening, open any tweet on X once to refresh.";
  }
  const conv = getConversation(id);
  if (!conv?.main) return `Couldn't read tweet ${id}.`;

  const parts = [`Post:\n${formatTweet(conv.main)}`];
  const replies = [...conv.replies.values()].slice(0, 10);
  if (replies.length) parts.push(`\nTop replies:\n${formatTweets(replies)}`);
  return parts.join('\n');
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
