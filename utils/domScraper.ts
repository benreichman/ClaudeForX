// DOM-scraping fallback for when network capture has nothing (e.g. the user
// clicked the button on a timeline tweet whose TweetDetail was never fetched).

import type { TweetData } from './types';

/** Tweet id for an <article> — from its timestamp permalink, else the page URL. */
export function tweetIdFromArticle(article: HTMLElement): string | null {
  const time = article.querySelector('a[href*="/status/"] time');
  const href = time?.closest('a')?.getAttribute('href') ?? '';
  const m = href.match(/status\/(\d+)/);
  if (m) return m[1];
  const pm = location.pathname.match(/status\/(\d+)/);
  return pm ? pm[1] : null;
}

export function scrapeArticle(article: HTMLElement): TweetData {
  const text =
    (article.querySelector('[data-testid="tweetText"]') as HTMLElement | null)?.innerText ??
    '';

  // User-Name block renders as "Name\n@handle\n·\ndate"
  const nameEl = article.querySelector('[data-testid="User-Name"]') as HTMLElement | null;
  let name = '';
  let handle = '';
  if (nameEl) {
    const parts = nameEl.innerText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    name = parts[0] ?? '';
    handle = (parts.find((p) => p.startsWith('@')) ?? '').replace(/^@/, '');
  }

  const createdAt = article.querySelector('time')?.getAttribute('datetime') ?? '';

  const media = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')].map((img) => ({
    type: 'photo',
    alt: (img as HTMLImageElement).alt ?? '',
    url: (img as HTMLImageElement).src || null,
  }));

  return {
    id: tweetIdFromArticle(article) ?? '',
    name,
    handle,
    text,
    createdAt,
    likes: null,
    retweets: null,
    replyCount: null,
    quotes: null,
    views: null,
    media,
    quoted: null,
    fromDom: true,
  };
}

/** Scrape every rendered tweet on the page (used on status pages as a fallback). */
export function scrapeVisibleThread(): TweetData[] {
  return [...document.querySelectorAll('article[data-testid="tweet"]')].map((a) =>
    scrapeArticle(a as HTMLElement),
  );
}
