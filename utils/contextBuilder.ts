// Builds the textual context block we hand to Claude: the main post, its media,
// engagement numbers, quoted tweet, and captured replies.

import {
  clearTemplate,
  ensureReplies,
  fetchDetail,
  fetchHomeTimeline,
  fetchProfilePosts,
  findTweet,
  getConversation,
  getProfilePosts,
  runOp,
} from './captureStore';
import { scrapeArticle, scrapeVisibleThread } from './domScraper';
import { getSettings } from './settings';
import { collectTweets } from './xParser';
import type { ApiImageBlock, FetchImagesRequest, TweetData } from './types';

const MAX_IMAGES = 4;

export interface GatheredContext {
  text: string;
  replyCount: number;
  source: 'network' | 'dom' | 'mixed';
  /** Base64 image blocks (from the main post + quoted post) for Claude's vision. */
  images: ApiImageBlock[];
  /** Non-fatal note shown in the panel (e.g. why replies couldn't be fetched). */
  notice?: string;
}

export async function gatherContext(
  tweetId: string,
  article: HTMLElement | null,
  onProgress?: (status: string) => void,
): Promise<GatheredContext> {
  const settings = await getSettings();
  const onStatusPage = location.pathname.includes(`/status/${tweetId}`);
  let conv = getConversation(tweetId);
  let notice: string | undefined;

  // If we don't already have the conversation (e.g. the user clicked from the
  // timeline, where X never fetched it), build a TweetDetail request ourselves.
  if (settings.activeFetch && (!conv || !conv.main || conv.replies.size === 0)) {
    onProgress?.('Fetching the conversation…');
    const r = await fetchDetail(tweetId);
    if (r.ok) {
      conv = getConversation(tweetId);
    } else if (r.status === 404 || r.status === 400) {
      // Cached queryId no longer valid — X rotated it. Drop it so we re-prime
      // from the next real tweet the page loads.
      await clearTemplate();
      notice = onStatusPage
        ? undefined // on the tweet's own page X will load replies itself anyway
        : "X updated its API, so replies couldn't be fetched. Open any tweet's page once to refresh, then try again.";
    } else if (r.error?.includes('template')) {
      notice = onStatusPage
        ? undefined
        : 'Open any tweet once to enable fetching replies from the timeline.';
    } else if (!onStatusPage) {
      notice = "Couldn't load replies just now — using the post on its own.";
    }
  }

  // Page through additional replies up to the configured maximum.
  if (conv && settings.activeFetch && conv.bottomCursor) {
    await ensureReplies(conv, settings.maxReplies, (n) =>
      onProgress?.(`Loading replies… (${n} so far)`),
    );
  }

  let main: TweetData | null = conv?.main ?? findTweet(tweetId);
  let replies: TweetData[] = conv ? [...conv.replies.values()] : [];
  let source: GatheredContext['source'] = 'network';

  if (!main) {
    source = 'dom';
    main = article ? scrapeArticle(article) : null;
  }
  if (!replies.length && onStatusPage) {
    const scraped = scrapeVisibleThread().filter(
      (t) => t.id && t.id !== tweetId && t.text,
    );
    if (scraped.length) {
      replies = scraped;
      if (source === 'network') source = 'mixed';
    }
  }
  if (!main) {
    throw new Error("Couldn't read this post from the page. Try opening the tweet first.");
  }

  replies = replies.slice(0, settings.maxReplies);
  const images = settings.sendImages ? await gatherImages(main) : [];
  return { text: formatContext(main, replies), replyCount: replies.length, source, images, notice };
}

/** Collect photo URLs from the main post (+ quoted) and have the worker encode them. */
async function gatherImages(main: TweetData): Promise<ApiImageBlock[]> {
  const urls: string[] = [];
  const pull = (t: TweetData) => {
    for (const m of t.media) if (m.type === 'photo' && m.url) urls.push(m.url);
  };
  pull(main);
  if (main.quoted) pull(main.quoted);

  const unique = [...new Set(urls)].slice(0, MAX_IMAGES);
  if (!unique.length) return [];

  try {
    const req: FetchImagesRequest = { type: 'fetch-images', urls: unique };
    const blocks = (await browser.runtime.sendMessage(req)) as (ApiImageBlock | null)[] | undefined;
    return Array.isArray(blocks) ? blocks.filter((b): b is ApiImageBlock => b != null) : [];
  } catch {
    // Worker unreachable (context invalidated) — proceed text-only.
    return [];
  }
}

/** Gather a profile (bio + posts) for a "who is this?" read. When X tools are
 * enabled, actively paginate the user's posts; otherwise use what was captured
 * passively + the visible DOM. */
export async function gatherProfileContext(
  handle: string,
  onProgress?: (status: string) => void,
): Promise<string> {
  const settings = await getSettings();
  if (settings.xTools) {
    onProgress?.(`Loading @${handle}'s posts…`);
    await fetchProfilePosts(handle, 3, (n) => onProgress?.(`Loading posts… (${n})`));
  }

  const nameEl = document.querySelector('[data-testid="UserName"]') as HTMLElement | null;
  const bioEl = document.querySelector('[data-testid="UserDescription"]') as HTMLElement | null;
  const name = (nameEl?.innerText ?? `@${handle}`).split('\n').filter(Boolean).join(' ');
  const bio = bioEl?.innerText?.trim() ?? '';

  // Header items like location, join date, following/followers counts.
  const headerItems = [...document.querySelectorAll('[data-testid="UserProfileHeader_Items"] *')]
    .map((e) => (e as HTMLElement).innerText?.trim())
    .filter(Boolean);
  const meta = [...new Set(headerItems)].slice(0, 6).join(' · ');

  // Prefer passively-captured UserTweets posts (richer + more of them); fall
  // back to DOM-scraped visible tweets. Dedupe by id, keep this user's posts.
  const lc = handle.toLowerCase();
  const byId = new Map<string, TweetData>();
  for (const t of [...getProfilePosts(handle), ...scrapeVisibleThread()]) {
    if (t.text && t.handle.toLowerCase() === lc && !byId.has(t.id)) byId.set(t.id, t);
  }
  const posts = [...byId.values()].slice(0, 60);

  const parts = [`=== PROFILE ===`, name];
  if (meta) parts.push(meta);
  parts.push(bio ? `Bio: ${bio}` : '(no bio)');
  if (posts.length) {
    parts.push('', `=== RECENT POSTS (${posts.length}) ===`);
    posts.forEach((t, i) => {
      const eng = t.likes != null ? ` [${fmtNum(t.likes)} likes]` : '';
      parts.push(`${i + 1}.${eng} ${t.text.replace(/\s+/g, ' ').slice(0, 400)}`);
    });
  } else {
    parts.push('', '(No posts visible on the page — scroll the profile and try again.)');
  }
  return parts.join('\n');
}

export type FeedScope = 'feed' | 'person' | 'topic';

export interface FeedDigestContext {
  text: string;
  count: number;
  /** Short human label for the source, shown in the panel meta line. */
  source: string;
}

/**
 * Gather posts for a "Catch me up" digest: the home feed, a person's posts, or
 * a topic search — all via session replay. Returns compact text for Claude plus
 * a count/source for the UI. Caller gates `feed` behind the Feed access opt-in.
 */
export async function gatherFeedDigestContext(
  scope: FeedScope,
  arg: string,
  onProgress?: (status: string) => void,
): Promise<FeedDigestContext> {
  let posts: TweetData[] = [];
  let source = 'your feed';

  if (scope === 'feed') {
    onProgress?.('Reading your feed…');
    posts = await fetchHomeTimeline(5, 120, (n) => onProgress?.(`Found ${n} posts…`));
  } else if (scope === 'person') {
    const handle = arg.replace(/^@/, '').trim();
    source = `@${handle}`;
    onProgress?.(`Reading @${handle}'s posts…`);
    await fetchProfilePosts(handle, 4, (n) => onProgress?.(`Found ${n} posts…`));
    const lc = handle.toLowerCase();
    posts = getProfilePosts(handle).filter((t) => t.handle.toLowerCase() === lc).slice(0, 120);
  } else {
    const query = arg.trim();
    source = `"${query}"`;
    onProgress?.(`Searching X for "${query}"…`);
    const res = await runOp('SearchTimeline', {
      rawQuery: query,
      product: 'Top',
      count: 40,
      querySource: 'typed_query',
      cursor: undefined,
    });
    posts = res.ok ? collectTweets(res.json, 120, true) : [];
  }

  onProgress?.('Summarizing…');
  return { text: formatFeed(posts, scope, source), count: posts.length, source };
}

function formatFeed(posts: TweetData[], scope: FeedScope, source: string): string {
  const header =
    scope === 'feed'
      ? 'HOME FEED'
      : scope === 'person'
        ? `RECENT POSTS FROM ${source}`
        : `X SEARCH — ${source}`;
  if (!posts.length) {
    return `=== ${header} ===\n(No posts could be read. ${
      scope === 'feed'
        ? 'Open your X home feed once, then try again.'
        : scope === 'person'
          ? 'Visit any profile on X once to enable this, then try again.'
          : 'Run a search on X once to enable this, then try again.'
    })`;
  }
  const parts = [`=== ${header} (${posts.length} posts, fetched live just now) ===`];
  posts.forEach((t, i) => {
    const eng = t.likes != null ? ` [${fmtNum(t.likes)}♥]` : '';
    const url = t.handle && t.id ? ` <https://x.com/${t.handle}/status/${t.id}>` : '';
    parts.push(`${i + 1}. @${t.handle}${eng}: ${truncate(t.text.replace(/\s+/g, ' '), 400)}${url}`);
  });
  return parts.join('\n');
}

function fmtNum(n: number | string | null): string {
  const v = typeof n === 'string' ? parseInt(n, 10) : n;
  if (v == null || Number.isNaN(v)) return '?';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function formatTweet(t: TweetData): string {
  const lines: string[] = [];
  lines.push(`@${t.handle}${t.name ? ` (${t.name})` : ''}${t.createdAt ? ` · ${t.createdAt}` : ''}`);
  lines.push(t.text || '(no text)');
  for (const m of t.media) {
    lines.push(`[attached ${m.type}${m.alt ? ` — alt text: ${m.alt}` : ' — no alt text available'}]`);
  }
  if (t.likes != null) {
    lines.push(
      `Engagement: ${fmtNum(t.likes)} likes · ${fmtNum(t.retweets)} reposts · ${fmtNum(t.replyCount)} replies${t.views ? ` · ${fmtNum(t.views)} views` : ''}`,
    );
  }
  if (t.quoted) {
    lines.push('Quoting this post:');
    lines.push(
      formatTweet(t.quoted)
        .split('\n')
        .map((l) => `  > ${l}`)
        .join('\n'),
    );
  }
  return lines.join('\n');
}

function formatContext(main: TweetData, replies: TweetData[]): string {
  const parts: string[] = ['=== MAIN POST ===', formatTweet(main)];
  if (replies.length) {
    parts.push('', `=== REPLIES (${replies.length} captured, roughly in X's relevance order) ===`);
    replies.forEach((r, i) => {
      const eng = r.likes != null ? ` [${fmtNum(r.likes)} likes]` : '';
      parts.push(`${i + 1}. @${r.handle}${eng}: ${truncate(r.text, 600)}`);
    });
  } else {
    parts.push('', '(No replies were captured for this post.)');
  }
  return parts.join('\n');
}
