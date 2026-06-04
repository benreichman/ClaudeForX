// MAIN-world content script, injected at document_start.
// Patches fetch + XHR to capture X's internal GraphQL responses (TweetDetail).
// It can also (a) replay the last TweetDetail with a new cursor to page through
// replies, and (b) build a fresh TweetDetail request for ANY tweet id — using a
// cached query template plus auth headers harvested from any GraphQL call — so
// we can fetch a conversation the user never navigated into (e.g. from the
// home timeline). Runs as the page, so the user's X session is used directly.

import type { ContentMessage, DetailTemplate, PageMessage } from '@/utils/types';

const INTERESTING = /\/i\/api\/graphql\/[^/]+\/(TweetDetail|TweetResultByRestId)/;
const GRAPHQL = /\/i\/api\/graphql\//;

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  runAt: 'document_start',
  world: 'MAIN',

  main() {
    const buffer: PageMessage[] = [];
    let ready = false;

    function emit(payload: PageMessage): void {
      if (!ready) {
        buffer.push(payload);
        if (buffer.length > 50) buffer.shift();
        return;
      }
      window.postMessage(payload, '*');
    }

    window.addEventListener('message', (e: MessageEvent) => {
      if (e.source !== window) return;
      const msg = e.data as ContentMessage;
      if (!msg || msg.source !== 'cgx-content') return;
      if (msg.type === 'ready') {
        ready = true;
        buffer.splice(0).forEach((m) => window.postMessage(m, '*'));
      } else if (msg.type === 'restore-template') {
        if (!detailTemplate) detailTemplate = msg.template;
      } else if (msg.type === 'clear-template') {
        // Cached query went stale (X rotated its queryId) — drop it so we
        // re-prime from the next genuine TweetDetail the page makes.
        detailTemplate = null;
      } else if (msg.type === 'fetch-more') {
        void fetchMore(msg.cursor, msg.requestId);
      } else if (msg.type === 'fetch-detail') {
        void fetchDetail(msg.tweetId, msg.requestId);
      }
    });

    // Auth headers (bearer, csrf, etc.) from the most recent GraphQL call — the
    // same across all operations, so a HomeTimeline call primes TweetDetail too.
    let lastAuthHeaders: Record<string, string> | null = null;
    // Last real TweetDetail request — replayed for cursor pagination.
    let lastDetailReq: { url: string; headers: Record<string, string> } | null = null;
    // Reusable TweetDetail query template (queryId/features/variables shape).
    let detailTemplate: DetailTemplate | null = null;

    function noteAuth(headers: Record<string, string> | null): void {
      if (headers?.authorization) lastAuthHeaders = headers;
    }

    function captureTemplate(url: string): void {
      try {
        const u = new URL(url, location.origin);
        const m = u.pathname.match(/\/graphql\/([^/]+)\/([^/?]+)/);
        if (!m) return;
        detailTemplate = {
          queryId: m[1],
          operationName: m[2],
          features: u.searchParams.get('features'),
          fieldToggles: u.searchParams.get('fieldToggles'),
          variables: JSON.parse(u.searchParams.get('variables') ?? '{}'),
        };
        emit({ source: 'cgx-page', type: 'detail-template', template: detailTemplate });
      } catch {
        // best effort
      }
    }

    function handleResponse(
      url: string,
      headers: Record<string, string> | null,
      bodyText: string,
    ): void {
      if (!INTERESTING.test(url)) return;
      const op = url.includes('TweetDetail') ? 'TweetDetail' : 'TweetResultByRestId';
      if (op === 'TweetDetail') {
        if (headers?.authorization) lastDetailReq = { url, headers };
        captureTemplate(url);
      }
      let json: unknown;
      try {
        json = JSON.parse(bodyText);
      } catch {
        return;
      }
      emit({ source: 'cgx-page', type: 'capture', op, url, json });
    }

    // ---- fetch interception ----
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const promise = origFetch(input, init);
      if (url && GRAPHQL.test(url)) {
        const headers = collectFetchHeaders(input, init);
        noteAuth(headers);
        if (INTERESTING.test(url)) {
          promise
            .then((res) => {
              res
                .clone()
                .text()
                .then((t) => handleResponse(url, headers, t))
                .catch(() => {});
            })
            .catch(() => {});
        }
      }
      return promise;
    };

    function collectFetchHeaders(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Record<string, string> {
      const out: Record<string, string> = {};
      try {
        const h =
          init?.headers ??
          (typeof input === 'object' && 'headers' in input ? input.headers : undefined);
        if (!h) return out;
        if (h instanceof Headers) h.forEach((v, k) => (out[k.toLowerCase()] = v));
        else if (Array.isArray(h)) h.forEach(([k, v]) => (out[k.toLowerCase()] = v));
        else Object.entries(h).forEach(([k, v]) => (out[k.toLowerCase()] = String(v)));
      } catch {
        // best effort
      }
      return out;
    }

    // ---- XHR interception (X's web app issues most GraphQL calls via XHR) ----
    type CgxXhr = XMLHttpRequest & {
      __cgxUrl?: string;
      __cgxHeaders?: Record<string, string>;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function (this: CgxXhr, ...args: unknown[]) {
      this.__cgxUrl = String(args[1] ?? '');
      this.__cgxHeaders = {};
      // @ts-expect-error - passthrough of original arguments
      return origOpen.apply(this, args);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (
      this: CgxXhr,
      k: string,
      v: string,
    ) {
      if (this.__cgxHeaders) this.__cgxHeaders[k.toLowerCase()] = v;
      return origSetHeader.call(this, k, v);
    };
    XMLHttpRequest.prototype.send = function (this: CgxXhr, ...args: unknown[]) {
      if (this.__cgxUrl && GRAPHQL.test(this.__cgxUrl)) {
        noteAuth(this.__cgxHeaders ?? null);
        if (INTERESTING.test(this.__cgxUrl)) {
          this.addEventListener('load', () => {
            try {
              handleResponse(
                this.responseURL || this.__cgxUrl!,
                this.__cgxHeaders ?? null,
                this.responseText,
              );
            } catch {
              // best effort
            }
          });
        }
      }
      // @ts-expect-error - passthrough of original arguments
      return origSend.apply(this, args);
    };

    /** Forwardable copy of harvested auth headers (drop per-request/computed ones). */
    function authForReplay(base: Record<string, string>): Record<string, string> {
      const headers = { ...base };
      delete headers['content-length'];
      delete headers['x-client-transaction-id'];
      return headers;
    }

    // ---- active pagination: replay the last TweetDetail with a new cursor ----
    async function fetchMore(cursor: string, requestId: number): Promise<void> {
      const base = lastDetailReq?.headers ?? lastAuthHeaders;
      if (!lastDetailReq || !base) {
        emit({
          source: 'cgx-page',
          type: 'fetch-more-result',
          requestId,
          ok: false,
          error: 'no TweetDetail request to replay',
        });
        return;
      }
      try {
        const u = new URL(lastDetailReq.url, location.origin);
        const vars = JSON.parse(u.searchParams.get('variables') ?? '{}');
        vars.cursor = cursor;
        u.searchParams.set('variables', JSON.stringify(vars));
        const res = await origFetch(u.toString(), {
          headers: authForReplay(base),
          credentials: 'include',
        });
        const text = await res.text();
        handleResponse(u.toString(), null, text);
        emit({ source: 'cgx-page', type: 'fetch-more-result', requestId, ok: res.ok, status: res.status });
      } catch (err) {
        emit({ source: 'cgx-page', type: 'fetch-more-result', requestId, ok: false, error: String(err) });
      }
    }

    // ---- build a TweetDetail request from scratch for an arbitrary tweet id ----
    async function fetchDetail(tweetId: string, requestId: number): Promise<void> {
      const template = detailTemplate;
      if (!template || !lastAuthHeaders) {
        emit({
          source: 'cgx-page',
          type: 'fetch-more-result',
          requestId,
          ok: false,
          error: !template
            ? 'no TweetDetail template yet — open any tweet once to prime it'
            : 'no auth headers captured yet',
        });
        return;
      }
      try {
        const vars: Record<string, unknown> = { ...template.variables, focalTweetId: tweetId };
        delete vars.cursor;
        const u = new URL(
          `${location.origin}/i/api/graphql/${template.queryId}/${template.operationName}`,
        );
        u.searchParams.set('variables', JSON.stringify(vars));
        if (template.features) u.searchParams.set('features', template.features);
        if (template.fieldToggles) u.searchParams.set('fieldToggles', template.fieldToggles);

        const headers = authForReplay(lastAuthHeaders);
        const res = await origFetch(u.toString(), { headers, credentials: 'include' });
        const text = await res.text();
        // Make subsequent cursor pagination work off this reconstructed request.
        lastDetailReq = { url: u.toString(), headers: lastAuthHeaders };
        handleResponse(u.toString(), null, text);
        emit({ source: 'cgx-page', type: 'fetch-more-result', requestId, ok: res.ok, status: res.status });
      } catch (err) {
        emit({ source: 'cgx-page', type: 'fetch-more-result', requestId, ok: false, error: String(err) });
      }
    }
  },
});
