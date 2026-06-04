import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Claude for X',
    description:
      'Grok-style AI sidebar for X — explain, summarize, fact-check posts. Claude by default, or any OpenAI-compatible model.',
    permissions: ['storage'],
    host_permissions: [
      'https://api.anthropic.com/*',
      'https://console.anthropic.com/*',
      // Lets the service worker fetch tweet images cross-origin (bypasses CORS)
      // to inline them as base64 for Claude's vision.
      'https://pbs.twimg.com/*',
      // Tavily web search (OpenAI-compatible provider path).
      'https://api.tavily.com/*',
    ],
    // Requested at runtime (from the options page) when the user saves a custom
    // OpenAI-compatible endpoint, so the worker may fetch that origin.
    optional_host_permissions: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    // No popup — clicking the toolbar icon opens the options page (see background.ts).
    action: {
      default_title: 'Claude for X — settings',
    },
    web_accessible_resources: [
      {
        resources: ['fonts/*'],
        matches: ['*://x.com/*', '*://twitter.com/*'],
      },
    ],
  },
});
