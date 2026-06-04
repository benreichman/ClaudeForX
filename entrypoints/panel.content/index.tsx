// ISOLATED-world content script: owns the capture store, injects the Claude
// buttons into tweet action bars, and mounts the React panel in a shadow root.

import './style.css';
import ReactDOM from 'react-dom/client';
import { initCaptureStore } from '@/utils/captureStore';
import App from './App';
import { injectButtons } from './buttons';

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  runAt: 'document_start',
  cssInjectionMode: 'ui',

  async main(ctx) {
    // Listen for captures immediately — the first TweetDetail often arrives
    // before the DOM is ready.
    initCaptureStore();

    const ui = await createShadowRootUi(ctx, {
      name: 'claude-for-x-panel',
      position: 'inline',
      anchor: 'body',
      onMount: (container) => {
        const app = document.createElement('div');
        container.append(app);
        const root = ReactDOM.createRoot(app);
        root.render(<App />);
        return root;
      },
      onRemove: (root) => {
        root?.unmount();
      },
    });

    const start = () => {
      ui.mount();
      injectButtons(ctx);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  },
});
