import type { Settings } from './types';

export const MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — fast, recommended' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 — smartest' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — fastest, cheapest' },
] as const;

export const DEFAULT_SETTINGS: Settings = {
  provider: 'anthropic',
  authMode: 'oauth',
  apiKey: '',
  model: 'claude-sonnet-4-6',
  openai: {
    baseUrl: '',
    apiKey: '',
    model: '',
    models: [],
    disableThinking: false,
    maxTokens: 4096,
    webSearchMode: 'off',
    tavilyKey: '',
  },
  maxReplies: 60,
  webSearch: true,
  activeFetch: true,
  sendImages: true,
  xTools: false,
  oauth: null,
};

export async function getSettings(): Promise<Settings> {
  try {
    const stored = await browser.storage.local.get({ ...DEFAULT_SETTINGS });
    return stored as unknown as Settings;
  } catch {
    // Extension context invalidated (reloaded while an old page is open).
    throw new Error('Extension was updated — refresh this tab to use Claude again.');
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await browser.storage.local.set(patch);
}
