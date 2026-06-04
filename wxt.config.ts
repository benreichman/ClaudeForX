import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Claude for X',
    description:
      'Ask Claude about any post on X — explain, summarize, fact-check. Like Grok, but Claude.',
    permissions: ['storage'],
    host_permissions: [
      'https://api.anthropic.com/*',
      'https://console.anthropic.com/*',
      // Lets the service worker fetch tweet images cross-origin (bypasses CORS)
      // to inline them as base64 for Claude's vision.
      'https://pbs.twimg.com/*',
    ],
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
