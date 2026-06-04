// Injects a Claude button into every tweet's action bar, right next to the
// Grok button when one exists. Lives in the page DOM (not the shadow root),
// so its styles go into document.head.

import { tweetIdFromArticle } from '@/utils/domScraper';
import { panelBus } from '@/utils/panelBus';
import { LOGO_SVG } from './logo';

const BTN_CLASS = 'cgx-btn';

const PAGE_STYLES = `
.${BTN_CLASS} {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
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
  color: #d97757;
  background-color: rgba(217, 119, 87, 0.12);
}
`;

interface InvalidationCtx {
  onInvalidated(cb: () => void): void;
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
    }, 300);
  };

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true });
  ctx.onInvalidated(() => {
    observer.disconnect();
    style.remove();
  });
  scan();
}

function scan(): void {
  document.querySelectorAll('article[data-testid="tweet"]').forEach((el) => {
    const article = el as HTMLElement;
    if (article.querySelector(`.${BTN_CLASS}`)) return;

    const grokBtn = article.querySelector('button[aria-label*="Grok" i]');
    const group = article.querySelector('div[role="group"]');
    if (!grokBtn && !group) return;

    const btn = makeButton(article);
    if (grokBtn) {
      // Action-bar buttons sit inside per-button cells — insert after Grok's cell.
      const cell = (grokBtn.closest('div[role="group"] > div') ?? grokBtn) as HTMLElement;
      cell.insertAdjacentElement('afterend', btn);
    } else if (group) {
      group.appendChild(btn);
    }
  });
}

function makeButton(article: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = BTN_CLASS;
  btn.type = 'button';
  btn.title = 'Ask Claude';
  btn.setAttribute('aria-label', 'Ask Claude about this post');
  btn.innerHTML = LOGO_SVG;
  btn.addEventListener('click', (e) => {
    // Keep X from treating this as a click on the tweet.
    e.preventDefault();
    e.stopPropagation();
    const tweetId = tweetIdFromArticle(article);
    if (tweetId) panelBus.open({ tweetId, article });
  });
  return btn;
}
