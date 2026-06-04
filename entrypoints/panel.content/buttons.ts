// Injects a Claude button next to X's Grok button — on every tweet (top-right,
// beside Grok or the "⋯" menu) and on profile pages (in the header, for a
// "who is this?" read). Lives in the page DOM, so its styles go to document.head.

import { tweetIdFromArticle } from '@/utils/domScraper';
import { panelBus } from '@/utils/panelBus';
import { LOGO_SVG } from './logo';

const BTN_CLASS = 'cgx-btn';
const PROFILE_BTN_CLASS = 'cgx-profile-btn';

const PAGE_STYLES = `
.${BTN_CLASS} {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  align-self: center;
  vertical-align: middle;
  width: 32px;
  height: 32px;
  margin: 0 2px;
  padding: 0;
  border: none;
  border-radius: 9999px;
  background: transparent;
  color: rgb(113, 118, 123);
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.${BTN_CLASS}:hover {
  color: #ff3e00;
  background-color: rgba(255, 62, 0, 0.12);
}
`;

interface InvalidationCtx {
  onInvalidated(cb: () => void): void;
}

// Path segments that are X features, not usernames.
const RESERVED = new Set([
  'home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i',
  'compose', 'bookmarks', 'jobs', 'lists', 'communities', 'premium', 'tos',
  'privacy', 'about', 'login', 'logout', 'signup', 'hashtag',
]);

function profileHandle(): string | null {
  const seg = location.pathname.split('/').filter(Boolean);
  if (seg.length !== 1) return null; // /handle only (not /handle/status/... etc.)
  return RESERVED.has(seg[0].toLowerCase()) ? null : seg[0];
}

export function injectButtons(ctx: InvalidationCtx): void {
  const style = document.createElement('style');
  style.textContent = PAGE_STYLES;
  document.head.appendChild(style);

  let scheduled = false;
  const scheduleScan = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      scan();
      scanProfile();
    }, 300);
  };

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });
  ctx.onInvalidated(() => {
    observer.disconnect();
    style.remove();
  });
  scan();
  scanProfile();
}

function scan(): void {
  document.querySelectorAll('article[data-testid="tweet"]').forEach((el) => {
    const article = el as HTMLElement;
    if (article.querySelector(`.${BTN_CLASS}`)) return;

    // Always anchor to the top-right cluster (beside Grok, else the ⋯ menu) so
    // placement is consistent — never the bottom action bar.
    const grokBtn = article.querySelector('button[aria-label*="Grok" i]');
    const btn = makeTweetButton(article);
    if (grokBtn) {
      grokBtn.insertAdjacentElement('afterend', btn);
      return;
    }
    const caret = article.querySelector('button[data-testid="caret"]');
    if (caret) {
      caret.insertAdjacentElement('beforebegin', btn);
      return;
    }
    btn.remove(); // no suitable anchor on this article
  });
}

// On a profile page, drop a Claude button into the sticky TOP BAR, next to the
// Grok + search icons (top-right of the primary column).
function scanProfile(): void {
  const handle = profileHandle();
  if (!handle) return;
  const pc = document.querySelector('[data-testid="primaryColumn"]');
  if (!pc) return;

  // The sticky header's right cluster holds the "Profile Summary" (Grok) icon
  // and the search icon, pinned to the very top. Anchor to the first of them
  // (leftmost) and sit just to its left.
  let anchor: Element | null = null;
  for (const el of pc.querySelectorAll('button[aria-label]')) {
    const label = (el.getAttribute('aria-label') ?? '').toLowerCase();
    if (!/profile summary|grok|search/.test(label)) continue;
    const r = el.getBoundingClientRect();
    if (r.top > 0 && r.top < 120 && r.right > window.innerWidth * 0.4) {
      anchor = el;
      break; // first in DOM order = leftmost (Profile Summary)
    }
  }
  if (!anchor) return;

  const host = anchor.parentElement;
  if (!host || host.querySelector(`.${PROFILE_BTN_CLASS}`)) return;
  anchor.insertAdjacentElement('beforebegin', makeProfileButton());
}

function baseButton(title: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = LOGO_SVG;
  return btn;
}

function makeTweetButton(article: HTMLElement): HTMLButtonElement {
  const btn = baseButton('Ask Claude about this post');
  btn.className = BTN_CLASS;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const tweetId = tweetIdFromArticle(article);
    if (tweetId) panelBus.open({ kind: 'tweet', tweetId, article });
  });
  return btn;
}

function makeProfileButton(): HTMLButtonElement {
  const btn = baseButton('Ask Claude about this profile');
  btn.className = `${BTN_CLASS} ${PROFILE_BTN_CLASS}`;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = profileHandle();
    if (handle) panelBus.open({ kind: 'profile', handle });
  });
  return btn;
}
