# Claude for X

Like Grok, but Claude. A Chrome extension (Manifest V3) that puts Claude on X/Twitter: a button on every post to explain / summarize / fact-check it, **and** an always-on launcher for a general Claude chat — with web search, image understanding, and (optionally) the ability to search X itself using your live session.

> ⚠️ **Personal, unofficial project.** It uses undocumented internals of X and (optionally) the Claude Code OAuth flow. Read the [risks](#honest-caveats--risks) before using or distributing it.

## Features

- **Per-post actions** — open any tweet (or click the Claude button from the timeline) and pick:
  - **Explain this post** · **Summarize thread** · **Is this true?** (fact-check)
  - Context includes the main post, its quoted post, engagement stats, **its images** (sent to Claude's vision), and replies in X's relevance order — fetched even from the timeline.
  - **Follow-up chat** — keep asking; the post + replies stay in context.
- **Always-on general chat** — a launcher bubble on every X page opens a standalone Claude chat (no specific post) with web search.
- **Web search** — native Anthropic server-side search for current info, cited as inline links.
- **Search X (experimental, off by default)** — let Claude search posts, pull a user's tweets, and fetch a tweet, using your logged-in session. See risks below.
- **Dark, Grok-style UI** — a floating bottom-right card that minimizes to a launcher bubble.

## How it works

- **A MAIN-world content script** (`entrypoints/interceptor.content.ts`) patches `fetch`/XHR inside x.com to capture X's internal GraphQL responses, learn reusable request templates per operation, and **replay** them (with your session) to fetch conversations, search results, and user timelines on demand. Because it runs *as the page*, your existing X session is used automatically — **no Twitter login or API keys.**
- **The panel content script** (`entrypoints/panel.content/`) injects the Claude button, renders the React panel in a Shadow DOM (so X's CSS and ours can't collide), executes the X tools, and falls back to scraping the rendered DOM when needed.
- **The background worker** (`entrypoints/background.ts`) streams from the Anthropic API and runs the agentic tool loop. Host permissions exempt it from CORS — no proxy server anywhere. It also fetches/encodes post images for vision.

## Setup

```bash
npm install
npm run build        # production build → .output/chrome-mv3
npm run dev          # dev mode with auto-reload
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `.output/chrome-mv3`. (`.output` is hidden in macOS file dialogs — press ⌘⇧. to show it.)

### Authentication (pick one in the extension's settings page)

Click the extension's toolbar icon to open settings.

1. **Claude subscription (Pro/Max)** — sign in with your Claude account via OAuth; usage bills against your subscription.
   ⚠️ **Unofficial.** This rides the Claude Code OAuth flow. It works, but it's a gray area in Anthropic's ToS and could break or get flagged. Personal use at your own risk.
2. **Anthropic API key** — pay-per-use from [console.anthropic.com](https://console.anthropic.com). The officially supported path.

Your key/tokens live only in the browser's extension storage (`browser.storage.local`) on your machine, and are sent only to `api.anthropic.com`. Nothing secret is in this repo.

## Settings

- **Auth** — Claude subscription (OAuth) or Anthropic API key
- **Model** — Sonnet 4.6 (default) / Opus 4.8 / Haiku 4.5
- **Max replies** to include in context (10–150)
- **Active reply pagination** on/off
- **Send images to Claude** (vision) on/off
- **Web search** on/off
- **Let Claude search X (experimental)** on/off — see below

## Searching X — how it works and what to know

When enabled, Claude gets three tools backed by your X session: `search_x`, `get_user_posts`, `get_tweet`. The worker asks the page to replay X's own `SearchTimeline` / `UserTweets` / `TweetDetail` GraphQL calls and feeds the results back to Claude. Capped at 5 tool calls per question.

To make this work without manual setup, the extension reproduces X's `x-client-transaction-id` request-signing scheme (`utils/xTransaction.ts`) — a publicly reverse-engineered algorithm. This is what lets search work zero-touch and survive page refreshes.

## Honest caveats / risks

- **Searching X is the most fragile and most ToS-sensitive feature.** It's automated, scripted access to X's internal API on your behalf, which is against X's automation rules and can hit rate limits or flag your account. It's **off by default and opt-in.** Use at your own risk.
- **The `x-client-transaction-id` generator will break.** X changes this anti-automation scheme periodically. When it does, search starts returning 404s; the `[claude-for-x]` console logs point to the broken stage, and re-porting from the upstream references is required. The captured-token fallback (search once on X manually to re-arm) keeps it limping meanwhile. **Per-post explain/summarize/fact-check is unaffected** — `TweetDetail` doesn't enforce the token.
- **X schema drift:** GraphQL response shapes are internal to X and change without notice. Parsers are defensive (resilient tweet extraction), but expect occasional breakage.
- **Cost:** on API-key mode, web search, X tool use, and images all add tokens/usage; on subscription mode they're included. Caps and toggles keep things bounded.
- The Grok-button selector and DOM fallbacks can break on X UI changes.

### References

The `x-client-transaction-id` implementation is ported from these reverse-engineering projects:
[Lqm1/x-client-transaction-id](https://github.com/Lqm1/x-client-transaction-id) (TypeScript) ·
[iSarabjitDhiman/XClientTransaction](https://github.com/iSarabjitDhiman/XClientTransaction) (Python).

## Roadmap

- A dedicated citations/sources panel for search results
- An "X tools status" indicator in settings (which operations are armed)
- "Open in Claude" handoff
- Video understanding (frame sampling)
