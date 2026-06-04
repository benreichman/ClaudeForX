// PKCE OAuth flow against the Claude (Claude Code) OAuth endpoints, so the
// extension can bill against a Claude Pro/Max subscription instead of API credits.
//
// ⚠️ Heads up: these tokens are scoped for Claude Code. Using them from a
// third-party client is a ToS gray area — fine to experiment with personally,
// but the API-key path is the officially supported one.

import type { OAuthTokens } from './types';

export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
export const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
export const SCOPES = 'org:create_api_key user:profile user:inference';

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export async function generatePkce(): Promise<PkcePair> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function buildAuthorizeUrl(pkce: PkcePair): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', pkce.verifier);
  return url.toString();
}

function toTokens(data: {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}, fallbackRefresh = ''): OAuthTokens {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? fallbackRefresh,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

/** Exchange the pasted "code#state" string for tokens. */
export async function exchangeCode(pasted: string, verifier: string): Promise<OAuthTokens> {
  const [code, state] = pasted.trim().split('#');
  if (!code) throw new Error('That code looks empty — paste the whole thing.');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      state: state ?? verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Code exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return toTokens(await res.json());
}

export async function refreshTokens(refreshToken: string): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    throw new Error('Claude session expired — reconnect in the extension settings.');
  }
  return toTokens(await res.json(), refreshToken);
}
