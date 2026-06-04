# Claude for X

Like Grok, but Claude. A Chrome extension that adds a Claude button next to the Grok button on every post on X — click it and Claude explains the post (or summarizes the thread, or fact-checks it) in a slide-in panel, with the post's replies as context.

## How it works

- **A MAIN-world content script** (`entrypoints/interceptor.content.ts`) patches `fetch`/XHR inside x.com and captures X's own internal GraphQL `TweetDetail` responses — the main post, engagement stats, quoted tweets, and replies in X's relevance order. It can also **replay** the last `TweetDetail` request with the next cursor to page through more replies without scrolling.
- Because it runs *as the page*, your existing X session is used automatically. **No Twitter login, no Twitter API keys, nothing to configure.**
- **The panel content script** (`entrypoints/panel.content/`) injects the Claude button into tweet action bars and renders a React panel in a shadow root (so X's CSS and ours can't collide). Falls back to scraping the rendered DOM when nothing was captured (e.g. timeline tweets).
- **The background worker** (`entrypoints/background.ts`) streams responses from the Anthropic API over a port. Host permissions exempt it from CORS — no proxy server anywhere.

## Setup

```bash
npm install
npm run build        # production build → .output/chrome-mv3
npm run dev          # dev mode with auto-reload
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `.output/chrome-mv3`.

### Authentication (pick one in the extension's settings page)

Click the extension's toolbar icon to open settings.

1. **Claude subscription (Pro/Max)** — sign in with your Claude account via OAuth; usage bills against your subscription.
   ⚠️ **Unofficial.** This rides the Claude Code OAuth flow. It works, but it's a gray area in Anthropic's ToS and could break or get flagged at any time. Personal use at your own risk; don't distribute an extension that depends on it.
2. **Anthropic API key** — pay-per-use from [console.anthropic.com](https://console.anthropic.com). The officially supported path.

## Actions

- **Explain this post** (default)
- **Summarize thread**
- **Is this true?** — fact-check, with optional web search
- *(planned: "open in Claude" handoff)*

## Settings

- Model (Sonnet 4.6 default / Opus 4.8 / Haiku 4.5)
- Max replies to include in context (10–150)
- Active reply pagination on/off (off = purely passive capture)
- Web search for fact-checks on/off

## Known limitations / honest caveats

- **X schema drift:** the GraphQL response shapes are internal to X and change without notice. The parser checks old + new field paths defensively, but expect occasional breakage.
- **Active pagination** replays X's own request minus the per-request `x-client-transaction-id` signature. It currently works; if X starts enforcing that header strictly, pagination degrades gracefully to passive capture (what's loaded as you scroll).
- **Media:** images/video are described only via alt text in v1. Vision support (sending images to Claude) is a natural v2 feature.
- The Grok button selector (`button[aria-label*="Grok"]`) and DOM fallback selectors can break when X ships UI changes; the action-bar fallback covers most cases.
