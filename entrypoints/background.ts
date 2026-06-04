// Background service worker: owns auth (OAuth refresh / API key) and streams
// completions from the Anthropic API back to the panel over a long-lived port.
// Requests run here because host_permissions exempt the worker from CORS.

import { refreshTokens } from '@/utils/oauth';
import { ACTIONS, CLAUDE_CODE_SYSTEM, MAIN_SYSTEM } from '@/utils/prompts';
import { getSettings } from '@/utils/settings';
import type {
  ApiImageBlock,
  OAuthTokens,
  RunRequest,
  Settings,
  StreamMessage,
} from '@/utils/types';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5_000_000;

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
    port.onDisconnect.addListener(() => controller.abort());
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as RunRequest;
      if (msg?.type !== 'run') return;
      run(port, msg, controller.signal).catch((err: unknown) => {
        const e = err as Error;
        if (e?.name !== 'AbortError') {
          send(port, { type: 'error', message: e?.message ?? String(err) });
        }
      });
    });
  });
});

type Port = ReturnType<typeof browser.runtime.connect>;

function send(port: Port, msg: StreamMessage): void {
  try {
    port.postMessage(msg);
  } catch {
    // Port already closed (panel dismissed) — nothing to do.
  }
}

async function run(port: Port, msg: RunRequest, signal: AbortSignal): Promise<void> {
  const settings = await getSettings();
  const action = ACTIONS[msg.action] ?? ACTIONS.explain;

  const system: { type: 'text'; text: string }[] = [];
  if (settings.authMode === 'oauth') {
    system.push({ type: 'text', text: CLAUDE_CODE_SYSTEM });
  }
  system.push({ type: 'text', text: MAIN_SYSTEM });

  const body: Record<string, unknown> = {
    model: settings.model,
    max_tokens: 2048,
    stream: true,
    system,
    messages: msg.messages,
  };
  if (action.webSearch && settings.webSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
  }

  let res = await callApi(settings, body, signal, false);
  // One retry on 401 with a forced token refresh (covers revoked/expired access tokens).
  if (res.status === 401 && settings.authMode === 'oauth') {
    res = await callApi(settings, body, signal, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(humanizeApiError(res.status, text));
  }

  await pumpSse(res, port);
  send(port, { type: 'done' });
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

/** Read the SSE stream and forward text deltas (and tool status) to the panel. */
async function pumpSse(res: Response, port: Port): Promise<void> {
  if (!res.body) throw new Error('Empty response stream from API.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

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

      let ev: { type?: string; [k: string]: unknown };
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }

      switch (ev.type) {
        case 'content_block_start': {
          const block = ev.content_block as { type?: string } | undefined;
          if (block?.type === 'server_tool_use') {
            send(port, { type: 'status', text: 'Searching the web…' });
          }
          break;
        }
        case 'content_block_delta': {
          const delta = ev.delta as { type?: string; text?: string } | undefined;
          if (delta?.type === 'text_delta' && delta.text) {
            send(port, { type: 'delta', text: delta.text });
          }
          break;
        }
        case 'error': {
          const e = ev.error as { message?: string } | undefined;
          send(port, { type: 'error', message: e?.message ?? 'Stream error' });
          break;
        }
      }
    }
  }
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
