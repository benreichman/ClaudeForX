// Parsers for X's internal GraphQL responses (TweetDetail / TweetResultByRestId).
// The schema is internal and shifts over time, so this is defensive `any`-land on
// purpose — every access is optional-chained with fallbacks for known old/new paths.
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Conversation, TweetData } from './types';

/** Unwrap a tweet_results.result object into our TweetData shape. */
export function parseTweetResult(result: any): TweetData | null {
  if (!result) return null;
  if (result.__typename === 'TweetWithVisibilityResults') result = result.tweet;
  if (!result) return null;
  const legacy = result.legacy;
  if (!legacy) return null;

  const user = result.core?.user_results?.result;
  // X has been migrating user fields from `legacy` into `core` — check both.
  const name = user?.core?.name ?? user?.legacy?.name ?? '';
  const handle = user?.core?.screen_name ?? user?.legacy?.screen_name ?? '';

  // Long posts ("notes") keep the full text outside `legacy.full_text`.
  const text: string =
    result.note_tweet?.note_tweet_results?.result?.text ?? legacy.full_text ?? '';

  const media = (legacy.extended_entities?.media ?? legacy.entities?.media ?? []).map(
    (m: any) => ({
      type: String(m.type ?? 'media'),
      alt: String(m.ext_alt_text ?? ''),
      // For photos this is the image; for video/gif it's the poster frame.
      url: m.media_url_https ? String(m.media_url_https) : null,
    }),
  );

  return {
    id: String(legacy.id_str ?? result.rest_id ?? ''),
    name,
    handle,
    text,
    createdAt: legacy.created_at ?? '',
    likes: legacy.favorite_count ?? null,
    retweets: legacy.retweet_count ?? null,
    replyCount: legacy.reply_count ?? null,
    quotes: legacy.quote_count ?? null,
    views: result.views?.count ?? null,
    media,
    quoted: parseTweetResult(result.quoted_status_result?.result),
  };
}

/** Extract the focal tweet id from a GraphQL request URL's `variables` param. */
export function focalIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url, location.origin);
    const vars = JSON.parse(u.searchParams.get('variables') ?? '{}');
    return vars.focalTweetId ?? vars.tweetId ?? null;
  } catch {
    return null;
  }
}

/** Fold a TweetDetail response into a conversation (main tweet, replies, cursor). */
export function ingestTweetDetail(conv: Conversation, focalId: string, json: any): void {
  const instructions =
    json?.data?.threaded_conversation_with_injections_v2?.instructions ?? [];
  for (const ins of instructions) {
    const entries =
      ins.type === 'TimelineAddEntries'
        ? ins.entries
        : ins.type === 'TimelineAddToModule'
          ? ins.moduleItems
          : null;
    if (!entries) continue;
    for (const entry of entries) ingestEntry(conv, focalId, entry);
  }
}

function ingestEntry(conv: Conversation, focalId: string, entry: any): void {
  const entryId: string = entry.entryId ?? '';
  const content = entry.content ?? entry.item;
  if (!content) return;

  if (entryId.startsWith('cursor-bottom')) {
    conv.bottomCursor = content.itemContent?.value ?? content.value ?? null;
    return;
  }

  // Standalone tweet entries (the focal tweet, and top-level replies).
  const ic = content.itemContent;
  if (ic?.tweet_results) addTweet(conv, focalId, parseTweetResult(ic.tweet_results.result));

  // Conversation-thread modules: a reply plus its sub-replies.
  for (const item of content.items ?? []) {
    const iic = item.item?.itemContent;
    if (!iic || iic.itemType === 'TimelineTimelineCursor') continue;
    if (iic.tweet_results) addTweet(conv, focalId, parseTweetResult(iic.tweet_results.result));
  }
}

function addTweet(conv: Conversation, focalId: string, t: TweetData | null): void {
  if (!t || !t.id) return;
  if (t.id === focalId) conv.main = t;
  else conv.replies.set(t.id, t);
}
