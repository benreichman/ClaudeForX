// ISOLATED-world content script: owns the capture store, injects the Claude
// buttons into tweet action bars, and mounts the React panel in a shadow root.

import './style.css';
import ReactDOM from 'react-dom/client';
import { initCaptureStore } from '@/utils/captureStore';
import App from './App';
import { injectButtons } from './buttons';

// Load the bundled Inter / JetBrains Mono variable fonts. @font-face must live
// in a document-level stylesheet (not the shadow root) and the url() has to be
// the extension origin, so we build it at runtime with the resolved asset URL.
function injectFonts(): void {
  if (document.getElementById('cgx-fonts')) return;
  try {
    const url = browser.runtime.getURL as (p: string) => string;
    const inter = url('/fonts/inter.woff2');
    const mono = url('/fonts/jbmono.woff2');
    const style = document.createElement('style');
    style.id = 'cgx-fonts';
    style.textContent = `
@font-face{font-family:'CGX Inter';font-style:normal;font-weight:100 900;font-display:swap;src:url('${inter}') format('woff2');}
@font-face{font-family:'CGX Mono';font-style:normal;font-weight:100 800;font-display:swap;src:url('${mono}') format('woff2');}`;
    (document.head ?? document.documentElement).appendChild(style);
  } catch {
    // Fonts are best-effort; the CSS falls back to system fonts.
  }
}

export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  runAt: 'document_start',
  cssInjectionMode: 'ui',

  async main(ctx) {
    // Listen for captures immediately — the first TweetDetail often arrives
    // before the DOM is ready.
    initCaptureStore();
    injectFonts();

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
