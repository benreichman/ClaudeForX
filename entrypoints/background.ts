// Background service worker: owns auth (OAuth refresh / API key) and streams
// completions from the Anthropic API back to the panel over a long-lived port.
// Requests run here because host_permissions exempt the worker from CORS.

import { refreshTokens } from '@/utils/oauth';
import {
  CLAUDE_CODE_SYSTEM,
  GENERAL_SYSTEM,
  MAIN_SYSTEM,
  X_TOOLS_SYSTEM,
} from '@/utils/prompts';
import { getSettings } from '@/utils/settings';
import type {
  ApiImageBlock,
  ChatMessage,
  ContentBlock,
  OAuthTokens,
  PanelToWorker,
  RunRequest,
  Settings,
  StreamMessage,
  WebSource,
} from '@/utils/types';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5_000_000;
const MAX_TOOL_CALLS = 5; // cap X-tool calls per question (rate-limit guard)
const MAX_TURNS = 6; // hard ceiling on agentic loop iterations

/** Tool definitions Claude can call against the user's X session. */
const X_TOOL_DEFS = [
  {
    name: 'search_x',
    description:
      "Search X (Twitter) for posts matching a query, using the user's logged-in session. Use for 'what are people saying about…', current discussion, or finding posts on a topic. Returns top matching posts with author, text, and engagement.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Search terms, like what you'd type into X search." },
        product: {
          type: 'string',
          enum: ['Top', 'Latest'],
          description: 'Top = most relevant (default); Latest = most recent.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_user_posts',
    description: "Get a specific X user's recent posts by their @handle.",
    input_schema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'The @handle, with or without the @.' },
      },
      required: ['handle'],
    },
  },
  {
    name: 'get_tweet',
    description: 'Fetch a specific X post and its top replies, by tweet id or URL.',
    input_schema: {
      type: 'object',
      properties: {
        id_or_url: { type: 'string', description: 'A tweet id or a full x.com/.../status/... URL.' },
      },
      required: ['id_or_url'],
    },
  },
];

type Port = ReturnType<typeof browser.runtime.connect>;

export default defineBackground(() => {
  // No popup — the toolbar icon opens settings.
  browser.action.onClicked.addListener(() => browser.runtime.openOptionsPage());

  browser.runtime.onMessage.addListener((msg: unknown) => {
    const m = msg as { type?: string; urls?: string[] };
    if (m?.type === 'open-options') {
      browser.runtime.openOptionsPage();
      return;
    }
    if (m?.type === 'fetch-images') {
      // Returning a promise responds asynchronously (webextension-polyfill).
      return fetchImages(m.urls ?? []);
    }
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'cgx') return;
    const controller = new AbortController();
    // Pending client-tool executions, resolved when the panel sends 'tool-result'.
    const toolWaiters = new Map<string, (content: string) => void>();

    port.onDisconnect.addListener(() => controller.abort());
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as PanelToWorker;
      if (msg?.type === 'tool-result') {
        const resolve = toolWaiters.get(msg.id);
        if (resolve) {
          toolWaiters.delete(msg.id);
          resolve(msg.content);
        }
        return;
      }
      if (msg?.type !== 'run') return;
      run(port, msg, controller.signal, toolWaiters).catch((err: unknown) => {
        const e = err as Error;
        if (e?.name !== 'AbortError') {
          send(port, { type: 'error', message: e?.message ?? String(err) });
        }
      });
    });
  });
});

function send(port: Port, msg: StreamMessage): void {
  try {
    port.postMessage(msg);
  } catch {
    // Port already closed (panel dismissed) — nothing to do.
  }
}

async function run(
  port: Port,
  msg: RunRequest,
  signal: AbortSignal,
  toolWaiters: Map<string, (content: string) => void>,
): Promise<void> {
  const settings = await getSettings();

  const system: { type: 'text'; text: string }[] = [];
  if (settings.authMode === 'oauth') {
    system.push({ type: 'text', text: CLAUDE_CODE_SYSTEM });
  }
  system.push({ type: 'text', text: msg.mode === 'general' ? GENERAL_SYSTEM : MAIN_SYSTEM });
  if (settings.xTools) system.push({ type: 'text', text: X_TOOLS_SYSTEM });

  const tools: unknown[] = [];
  if (settings.webSearch) {
    tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 });
  }
  if (settings.xTools) tools.push(...X_TOOL_DEFS);

  const messages: ChatMessage[] = [...msg.messages];
  let toolBudget = MAX_TOOL_CALLS;
  const citations: WebSource[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const body: Record<string, unknown> = {
      model: settings.model,
      max_tokens: 2048,
      stream: true,
      system,
      messages,
    };
    if (tools.length) body.tools = tools;

    const { stopReason, blocks } = await streamOnce(settings, body, signal, port, citations);

    // Only OUR client tools require a follow-up turn; web_search is server-side.
    const toolUses = blocks.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
        b.type === 'tool_use',
    );
    if (stopReason !== 'tool_use' || toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: blocks });

    const results: ContentBlock[] = [];
    for (const tu of toolUses) {
      if (toolBudget <= 0) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: '(tool-call limit reached for this question)' });
        continue;
      }
      toolBudget--;
      send(port, { type: 'status', text: toolStatus(tu.name, tu.input) });
      const content = await execTool(port, toolWaiters, tu.id, tu.name, tu.input, signal);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content });
    }
    messages.push({ role: 'user', content: results });
  }

  if (citations.length) {
    const seen = new Set<string>();
    const deduped = citations.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
    send(port, { type: 'web-sources', sources: deduped });
  }
  send(port, { type: 'done' });
}

function toolStatus(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === 'search_x') return `Searching X for “${String(i.query ?? '')}”…`;
  if (name === 'get_user_posts') return `Fetching @${String(i.handle ?? '').replace(/^@/, '')}'s posts…`;
  if (name === 'get_tweet') return 'Fetching that post…';
  return 'Working…';
}

/** Ask the panel (content script) to run a client tool; await its result. */
function execTool(
  port: Port,
  waiters: Map<string, (content: string) => void>,
  id: string,
  name: string,
  input: unknown,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve('(cancelled)');
    waiters.set(id, resolve);
    send(port, { type: 'tool-exec', id, name, input });
    const onAbort = () => {
      if (waiters.delete(id)) resolve('(cancelled)');
    };
    signal.addEventListener('abort', onAbort, { once: true });
    setTimeout(() => {
      if (waiters.delete(id)) resolve('(tool timed out)');
    }, 20_000);
  });
}

async function callApi(
  settings: Settings,
  body: Record<string, unknown>,
  signal: AbortSignal,
  forceRefresh: boolean,
): Promise<Response> {
  const auth = await getAuthHeaders(settings, forceRefresh);
  return fetch(API_URL, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      // Required for any browser-origin request (extension workers included).
      'anthropic-dangerous-direct-browser-access': 'true',
      ...auth,
    },
    body: JSON.stringify(body),
  });
}

async function getAuthHeaders(
  settings: Settings,
  forceRefresh: boolean,
): Promise<Record<string, string>> {
  if (settings.authMode === 'apikey') {
    if (!settings.apiKey) {
      throw new Error('No API key configured — open the extension settings to add one.');
    }
    return { 'x-api-key': settings.apiKey };
  }

  let oauth: OAuthTokens | null = settings.oauth;
  if (!oauth?.refreshToken) {
    throw new Error('Not connected to Claude — open the extension settings to sign in.');
  }
  if (forceRefresh || !oauth.accessToken || Date.now() > oauth.expiresAt - 60_000) {
    oauth = await refreshTokens(oauth.refreshToken);
    await browser.storage.local.set({ oauth });
  }
  return {
    authorization: `Bearer ${oauth.accessToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
  };
}

function humanizeApiError(status: number, body: string): string {
  let detail = '';
  try {
    detail = JSON.parse(body)?.error?.message ?? '';
  } catch {
    detail = body.slice(0, 200);
  }
  switch (status) {
    case 401:
      return `Authentication failed — reconnect or re-enter your key in settings. ${detail}`;
    case 429:
      return `Rate limited by Anthropic — wait a moment and try again. ${detail}`;
    case 529:
      return 'Anthropic is overloaded right now — try again shortly.';
    default:
      return `API error ${status}: ${detail || 'unknown error'}`;
  }
}

interface StreamResult {
  stopReason: string | null;
  blocks: ContentBlock[];
}

/**
 * Make one streaming API call. Forwards text deltas to the panel, faithfully
 * accumulates ALL content blocks (text / tool_use / server tool blocks) so the
 * assistant turn can be replayed back to the API, and returns the stop reason.
 */
async function streamOnce(
  settings: Settings,
  body: Record<string, unknown>,
  signal: AbortSignal,
  port: Port,
  citations: WebSource[],
): Promise<StreamResult> {
  let res = await callApi(settings, body, signal, false);
  if (res.status === 401 && settings.authMode === 'oauth') {
    res = await callApi(settings, body, signal, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(humanizeApiError(res.status, text));
  }
  if (!res.body) throw new Error('Empty response stream from API.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  // Accumulate blocks by index; track partial tool-input JSON separately.
  const blocks: Record<number, ContentBlock> = {};
  const toolJson: Record<number, string> = {};
  let stopReason: string | null = null;
  let lastWebQuery = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;

      let ev: { type?: string; index?: number; [k: string]: unknown };
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }

      switch (ev.type) {
        case 'content_block_start': {
          const i = ev.index ?? 0;
          const block = { ...(ev.content_block as Record<string, unknown>) } as ContentBlock;
          blocks[i] = block;
          if (block.type === 'server_tool_use') {
            send(port, { type: 'status', text: 'Searching the web…' });
          } else if (block.type === 'web_search_tool_result') {
            // Results arrive whole here (not via deltas).
            const content = (block as { content?: unknown }).content;
            const results = webResultsFrom(content);
            send(port, { type: 'web-search-results', query: lastWebQuery, results });
          }
          break;
        }
        case 'content_block_delta': {
          const i = ev.index ?? 0;
          const delta = ev.delta as {
            type?: string;
            text?: string;
            partial_json?: string;
            citation?: { url?: string; title?: string };
          };
          if (delta?.type === 'text_delta' && delta.text) {
            send(port, { type: 'delta', text: delta.text });
            const b = blocks[i] as { type: string; text?: string };
            if (b && b.type === 'text') b.text = (b.text ?? '') + delta.text;
          } else if (delta?.type === 'input_json_delta') {
            toolJson[i] = (toolJson[i] ?? '') + (delta.partial_json ?? '');
          } else if (delta?.type === 'citations_delta' && delta.citation?.url) {
            citations.push({ url: delta.citation.url, title: delta.citation.title ?? delta.citation.url });
          }
          break;
        }
        case 'content_block_stop': {
          const i = ev.index ?? 0;
          const b = blocks[i] as { type?: string; name?: string; input?: unknown } | undefined;
          if (b && (b.type === 'tool_use' || b.type === 'server_tool_use') && toolJson[i]) {
            try {
              b.input = JSON.parse(toolJson[i]);
            } catch {
              b.input = {};
            }
          }
          // A completed web-search query block → tell the panel a search started.
          if (b?.type === 'server_tool_use' && b.name === 'web_search') {
            lastWebQuery = String((b.input as { query?: string })?.query ?? '');
            send(port, { type: 'web-search-start', query: lastWebQuery });
          }
          break;
        }
        case 'message_delta': {
          const d = ev.delta as { stop_reason?: string } | undefined;
          if (d?.stop_reason) stopReason = d.stop_reason;
          break;
        }
        case 'error': {
          const e = ev.error as { message?: string } | undefined;
          throw new Error(e?.message ?? 'Stream error');
        }
      }
    }
  }

  const ordered = Object.keys(blocks)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => blocks[i]);
  return { stopReason, blocks: ordered };
}

/** Pull {url,title} out of a web_search_tool_result block's content array. */
function webResultsFrom(content: unknown): WebSource[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((r) => r && (r as { type?: string }).type === 'web_search_result')
    .map((r) => {
      const o = r as { url?: string; title?: string };
      return { url: o.url ?? '', title: o.title ?? o.url ?? '' };
    })
    .filter((r) => r.url);
}

// ---- image fetching (runs in the worker so host_permissions bypass CORS) ----

async function fetchImages(urls: string[]): Promise<(ApiImageBlock | null)[]> {
  const unique = [...new Set(urls)].slice(0, MAX_IMAGES);
  return Promise.all(unique.map(fetchOneImage));
}

async function fetchOneImage(url: string): Promise<ApiImageBlock | null> {
  try {
    // Ask X for the smaller variant — plenty for vision, keeps payloads light.
    const small = /[?&]name=/.test(url)
      ? url
      : `${url}${url.includes('?') ? '&' : '?'}name=small`;
    const res = await fetch(small);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > MAX_IMAGE_BYTES) return null;
    const data = base64FromBuffer(await blob.arrayBuffer());

    let mediaType = blob.type;
    if (!mediaType.startsWith('image/')) mediaType = 'image/jpeg';
    if (mediaType === 'image/jpg') mediaType = 'image/jpeg';
    // Anthropic accepts jpeg/png/gif/webp only.
    if (!/^image\/(jpeg|png|gif|webp)$/.test(mediaType)) mediaType = 'image/jpeg';

    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  } catch {
    return null;
  }
}

function base64FromBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000; // avoid arg-count limits on String.fromCharCode
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
