// MAIN-world content script, injected at document_start.
// Patches fetch + XHR to (a) capture X's TweetDetail responses for the panel,
// (b) learn a reusable request template for EVERY GraphQL operation it sees
// (queryId/features/variables), and (c) replay any of those operations on demand
// — TweetDetail (for conversations) and arbitrary read ops like SearchTimeline /
// UserTweets (for the X tools). Runs as the page, so the user's X session is used.

import type { ContentMessage, GqlTemplate, PageMessage } from '@/utils/types';
import { generateTransactionId } from '@/utils/xTransaction';

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
        if (buffer.length > 80) buffer.shift();
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
      } else if (msg.type === 'restore-templates') {
        for (const [op, tpl] of Object.entries(msg.templates)) {
          if (!templates[op]) templates[op] = tpl;
        }
      } else if (msg.type === 'clear-template') {
        delete templates[msg.op];
      } else if (msg.type === 'fetch-more') {
        void fetchMore(msg.cursor, msg.requestId);
      } else if (msg.type === 'fetch-detail') {
        void fetchDetail(msg.tweetId, msg.requestId);
      } else if (msg.type === 'run-op') {
        void runOp(msg.op, msg.variables, msg.requestId);
      }
    });

    // Auth headers (bearer, csrf, etc.) from the most recent GraphQL call.
    let lastAuthHeaders: Record<string, string> | null = null;
    // Last real TweetDetail request — replayed for cursor pagination.
    let lastDetailReq: { url: string; headers: Record<string, string> } | null = null;
    // Reusable query templates, keyed by operation name.
    const templates: Record<string, GqlTemplate> = {};
    // The most recent real request headers per operation — kept in memory only
    // (they hold per-request tokens like x-client-transaction-id that some
    // endpoints, e.g. SearchTimeline, enforce). Never persisted.
    const opHeaders: Record<string, Record<string, string>> = {};

    function noteAuth(headers: Record<string, string> | null): void {
      if (headers?.authorization) lastAuthHeaders = headers;
    }

    function captureTemplate(url: string, headers: Record<string, string>): void {
      try {
        const u = new URL(url, location.origin);
        const m = u.pathname.match(/\/graphql\/([^/]+)\/([^/?]+)/);
        if (!m) return;
        const queryId = m[1];
        const op = m[2];
        if (headers.authorization) opHeaders[op] = headers;
        const changed = templates[op]?.queryId !== queryId;
        const template: GqlTemplate = {
          queryId,
          operationName: op,
          features: u.searchParams.get('features'),
          fieldToggles: u.searchParams.get('fieldToggles'),
          variables: JSON.parse(u.searchParams.get('variables') ?? '{}'),
        };
        templates[op] = template;
        // Only notify the content script when the queryId is new/rotated, to
        // avoid a storage write on every GraphQL call as the user scrolls.
        if (changed) emit({ source: 'cgx-page', type: 'gql-template', op, template });
      } catch {
        // POST/persisted ops or unusual URLs — ignore.
      }
    }

    function handleResponse(
      url: string,
      headers: Record<string, string> | null,
      bodyText: string,
    ): void {
      if (!INTERESTING.test(url)) return;
      const op = url.includes('TweetDetail') ? 'TweetDetail' : 'TweetResultByRestId';
      if (op === 'TweetDetail' && headers?.authorization) {
        lastDetailReq = { url, headers };
      }
      let json: unknown;
      try {
        json = JSON.parse(bodyText);
      } catch {
        return;
      }
      emit({ source: 'cgx-page', type: 'capture', op, url, json });
    }

    function onGraphqlRequest(url: string, headers: Record<string, string>): void {
      noteAuth(headers);
      captureTemplate(url, headers);
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
        onGraphqlRequest(url, headers);
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

    // ---- XHR interception ----
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
        onGraphqlRequest(this.__cgxUrl, this.__cgxHeaders ?? {});
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

    /** Forwardable copy of harvested headers (drop per-request/computed ones). */
    function authForReplay(base: Record<string, string>): Record<string, string> {
      const headers = { ...base };
      delete headers['content-length'];
      delete headers['x-client-transaction-id'];
      return headers;
    }

    // ---- replay TweetDetail with a new cursor (reply pagination) ----
    async function fetchMore(cursor: string, requestId: number): Promise<void> {
      const base = lastDetailReq?.headers ?? lastAuthHeaders;
      if (!lastDetailReq || !base) {
        emit({ source: 'cgx-page', type: 'fetch-more-result', requestId, ok: false, error: 'no TweetDetail request to replay' });
        return;
      }
      try {
        const u = new URL(lastDetailReq.url, location.origin);
        const vars = JSON.parse(u.searchParams.get('variables') ?? '{}');
        vars.cursor = cursor;
        u.searchParams.set('variables', JSON.stringify(vars));
        const res = await origFetch(u.toString(), { headers: authForReplay(base), credentials: 'include' });
        const text = await res.text();
        handleResponse(u.toString(), null, text);
        emit({ source: 'cgx-page', type: 'fetch-more-result', requestId, ok: res.ok, status: res.status });
      } catch (err) {
        emit({ source: 'cgx-page', type: 'fetch-more-result', requestId, ok: false, error: String(err) });
      }
    }

    // ---- build a TweetDetail request from scratch for an arbitrary tweet id ----
    async function fetchDetail(tweetId: string, requestId: number): Promise<void> {
      const template = templates['TweetDetail'];
      if (!template || !lastAuthHeaders) {
        emit({
          source: 'cgx-page',
          type: 'fetch-more-result',
          requestId,
          ok: false,
          error: !template ? 'no TweetDetail template yet' : 'no auth headers captured yet',
        });
        return;
      }
      try {
        const u = buildOpUrl(template, { ...template.variables, focalTweetId: tweetId, cursor: undefined });
        const headers = authForReplay(lastAuthHeaders);
        const res = await origFetch(u, { headers, credentials: 'include' });
        const text = await res.text();
        lastDetailReq = { url: u, headers: lastAuthHeaders };
        handleResponse(u, null, text);
        emit({ source: 'cgx-page', type: 'fetch-more-result', requestId, ok: res.ok, status: res.status });
      } catch (err) {
        emit({ source: 'cgx-page', type: 'fetch-more-result', requestId, ok: false, error: String(err) });
      }
    }

    // ---- generic: replay any templated read operation with variable overrides ----
    async function runOp(
      op: string,
      overrides: Record<string, unknown>,
      requestId: number,
    ): Promise<void> {
      const template = templates[op];
      // Prefer the operation's OWN captured headers — they carry the
      // x-client-transaction-id this endpoint enforces. Fall back to generic
      // auth headers (minus the token, since a mismatched one is worse).
      const own = opHeaders[op];
      const base = own ?? lastAuthHeaders;
      if (!template || !base) {
        emit({
          source: 'cgx-page',
          type: 'op-result',
          requestId,
          ok: false,
          error: !template
            ? `no template for ${op} yet — do this once on X to enable it`
            : 'no auth headers captured yet',
        });
        return;
      }
      try {
        const merged = { ...template.variables, ...overrides };
        const url = buildOpUrl(template, merged);
        const headers = { ...base };
        delete headers['content-length'];
        if (!own) {
          // No captured token for this op (e.g. after a refresh) — mint one.
          // A wrong token from another op would be worse than a generated one.
          const gen = await generateTransactionId('GET', new URL(url).pathname);
          if (gen) headers['x-client-transaction-id'] = gen;
          else delete headers['x-client-transaction-id'];
        }
        const res = await origFetch(url, { headers, credentials: 'include' });
        const text = await res.text();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        emit({ source: 'cgx-page', type: 'op-result', requestId, ok: res.ok, status: res.status, json });
      } catch (err) {
        emit({ source: 'cgx-page', type: 'op-result', requestId, ok: false, error: String(err) });
      }
    }

    function buildOpUrl(template: GqlTemplate, variables: Record<string, unknown>): string {
      // Drop keys explicitly set to undefined (e.g. a stale cursor).
      const vars: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(variables)) if (v !== undefined) vars[k] = v;
      const u = new URL(
        `${location.origin}/i/api/graphql/${template.queryId}/${template.operationName}`,
      );
      u.searchParams.set('variables', JSON.stringify(vars));
      if (template.features) u.searchParams.set('features', template.features);
      if (template.fieldToggles) u.searchParams.set('fieldToggles', template.fieldToggles);
      return u.toString();
    }
  },
});
