// Best-effort cost estimation for the usage meter.
//
// Token counts are exact (the API returns them). Dollars are only an estimate,
// and only possible when we recognize the model — so priceFor() returns null
// for anything we don't have a rate for (most OpenAI-compatible / local models),
// and the UI then shows tokens alone. Rates are USD per 1,000,000 tokens.

import type { UsageInfo } from './types';

export interface TokenPrice {
  in: number;
  out: number;
}

// Anthropic's web_search tool is billed PER REQUEST, separately from tokens.
// Published rate: $10 per 1,000 searches → $0.01 each. Verify against the
// current Anthropic pricing page; update here if it changes.
export const WEB_SEARCH_FEE_USD = 0.01;

/**
 * Look up a model's price by family. Matches on substring so version suffixes
 * (claude-opus-4-8, claude-sonnet-4-6-20250101, …) all resolve. Returns null
 * when we don't know the model — the caller shows tokens without a dollar value.
 */
export function priceFor(model: string): TokenPrice | null {
  const m = (model || '').toLowerCase();
  if (!m) return null;
  // Anthropic published tiers (USD / 1M tokens).
  if (m.includes('opus')) return { in: 15, out: 75 };
  if (m.includes('sonnet')) return { in: 3, out: 15 };
  if (m.includes('haiku')) return { in: 1, out: 5 };
  return null;
}

/** Estimated USD for a usage record at the given price, or null if unpriced.
 * Includes the per-request web-search fee when searches were performed. */
export function estimateCost(usage: UsageInfo, price: TokenPrice | null): number | null {
  if (!price) return null;
  const tokenCost = (usage.inputTokens * price.in + usage.outputTokens * price.out) / 1_000_000;
  const searchCost = (usage.webSearches ?? 0) * WEB_SEARCH_FEE_USD;
  return tokenCost + searchCost;
}

/** Compact token count: 412 → "412", 4234 → "4.2k". */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

/** Compact dollar amount: more precision for tiny costs. */
export function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
