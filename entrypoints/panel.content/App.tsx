import { useCallback, useEffect, useRef, useState } from 'react';
import { gatherContext } from '@/utils/contextBuilder';
import { renderMarkdown } from '@/utils/markdown';
import { panelBus, type OpenRequest } from '@/utils/panelBus';
import { ACTIONS } from '@/utils/prompts';
import type {
  ActionId,
  ApiImageBlock,
  ChatMessage,
  RunRequest,
  StreamMessage,
} from '@/utils/types';
import { LOGO_SVG } from './logo';

type Port = ReturnType<typeof browser.runtime.connect>;

/** Suggested starters shown in the general (no-tweet) empty state. */
const GENERAL_PROMPTS = [
  "What's in the news today?",
  "What's trending in tech right now?",
  'Explain a topic that’s blowing up online',
];

/**
 * Where to place the minimized launcher so it sits *above* X's own bottom-right
 * floating buttons (its Grok FAB) instead of overlapping them. Returns a `bottom`
 * offset in px. Falls back to the corner when X has no floating button.
 */
function computeLauncherBottom(): number {
  const margin = 20;
  const gap = 14;
  let topMost: number | null = null;
  // X's floating Grok button carries a "Grok" aria-label and lives in the
  // bottom-right corner. Per-tweet Grok buttons match too but sit mid-page,
  // so the corner filter excludes them.
  for (const el of document.querySelectorAll('[aria-label*="Grok" i]')) {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (!r.width || !r.height || r.height > 110) continue;
    const inCorner =
      r.right > window.innerWidth - 150 && r.bottom > window.innerHeight - 220;
    if (inCorner) topMost = topMost === null ? r.top : Math.min(topMost, r.top);
  }
  if (topMost === null) return margin;
  return Math.max(margin, Math.round(window.innerHeight - topMost + gap));
}

/** A chat turn: `content` is what goes to the API, `display` what we render.
 * They differ only for the first user turn, whose content embeds the whole
 * captured thread but displays as just the action label. */
interface Turn extends ChatMessage {
  content: string;
  display: string;
  /** Images attached to this turn (only the first user turn carries them). */
  images?: ApiImageBlock[];
}

export default function App() {
  const [request, setRequest] = useState<OpenRequest | null>(null);
  const [action, setAction] = useState<ActionId>('explain');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [meta, setMeta] = useState('');
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  // Panel expanded vs. minimized to the launcher bubble. Closed by default, so
  // the launcher is present on every X page (always-on mode).
  const [open, setOpen] = useState(false);
  const [launcherBottom, setLauncherBottom] = useState(20);

  // No `request` = general (no-tweet) chat mode.
  const general = request === null;

  const portRef = useRef<Port | null>(null);
  const actionRef = useRef<ActionId>('explain');
  actionRef.current = action;
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Disconnecting a port whose extension context was invalidated (after a
  // reload) throws — swallow it so callers like close() always proceed.
  const disconnectPort = useCallback(() => {
    try {
      portRef.current?.disconnect();
    } catch {
      // context invalidated — nothing to disconnect
    }
    portRef.current = null;
  }, []);

  // Keep the transcript pinned to the bottom while streaming.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, status]);

  // While minimized, keep the launcher clear of X's bottom-right buttons.
  useEffect(() => {
    if (open) return;
    const measure = () => setLauncherBottom(computeLauncherBottom());
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  /** Stream a completion for `messages`, appending into a fresh assistant turn. */
  const stream = useCallback((act: ActionId, messages: Turn[], mode: 'tweet' | 'general') => {
    disconnectPort();
    setError(null);
    setBusy(true);
    setStatus('Thinking…');
    setTurns([...messages, { role: 'assistant', content: '', display: '' }]);

    let port: Port;
    try {
      port = browser.runtime.connect({ name: 'cgx' });
    } catch {
      setStatus('');
      setBusy(false);
      setError('Extension was updated — refresh this tab to use Claude again.');
      return;
    }
    portRef.current = port;
    port.onMessage.addListener((raw: unknown) => {
      const m = raw as StreamMessage;
      if (m.type === 'delta') {
        setStatus('');
        setTurns((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = {
            ...last,
            content: last.content + m.text,
            display: last.display + m.text,
          };
          return next;
        });
      } else if (m.type === 'status') {
        setStatus(m.text);
      } else if (m.type === 'done') {
        setStatus('');
        setBusy(false);
        portRef.current = null;
        inputRef.current?.focus();
      } else if (m.type === 'error') {
        setStatus('');
        setBusy(false);
        setError(m.message);
      }
    });

    const apiMessages: ChatMessage[] = messages.map((t) => {
      if (t.role === 'user' && t.images?.length) {
        return { role: 'user', content: [{ type: 'text', text: t.content }, ...t.images] };
      }
      return { role: t.role, content: t.content };
    });
    const runMsg: RunRequest = { type: 'run', action: act, mode, messages: apiMessages };
    port.postMessage(runMsg);
  }, [disconnectPort]);

  /** Start a fresh conversation for a tweet with the given action. */
  const startRun = useCallback(
    async (act: ActionId, req: OpenRequest) => {
      disconnectPort();
      setTurns([]);
      setError(null);
      setNotice(null);
      setMeta('');
      setBusy(true);
      setStatus('Reading the thread…');

      let ctx;
      try {
        ctx = await gatherContext(req.tweetId, req.article, setStatus);
      } catch (e) {
        setStatus('');
        setBusy(false);
        setError((e as Error).message);
        return;
      }
      setNotice(ctx.notice ?? null);
      const imgNote = ctx.images.length ? ` · ${ctx.images.length} img` : '';
      setMeta(`post + ${ctx.replyCount} replies${imgNote} · ${ctx.source}`);

      const first: Turn = {
        role: 'user',
        content: `${ACTIONS[act].instruction}\n\n${ctx.text}`,
        display: ACTIONS[act].label,
        images: ctx.images,
      };
      stream(act, [first], 'tweet');
    },
    [stream, disconnectPort],
  );

  useEffect(() => {
    return panelBus.onOpen((req) => {
      setOpen(true);
      setRequest(req);
      void startRun(actionRef.current, req);
    });
  }, [startRun]);

  // Fully reset to a general, empty chat and minimize.
  const close = () => {
    disconnectPort();
    setRequest(null);
    setTurns([]);
    setNotice(null);
    setMeta('');
    setError(null);
    setBusy(false);
    setOpen(false);
  };

  const openOptions = () => {
    try {
      void browser.runtime.sendMessage({ type: 'open-options' });
    } catch {
      setError('Extension was updated — refresh this tab to use Claude again.');
    }
  };

  const onActionChange = (value: ActionId) => {
    setAction(value);
    if (request) void startRun(value, request);
  };

  /** Append a user message and stream a reply (works in both modes). */
  const sendText = (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    setInput('');
    // Drop any empty assistant turn left behind by an errored run.
    const history = turns.filter((t) => !(t.role === 'assistant' && !t.content));
    stream(action, [...history, { role: 'user', content: text, display: text }], request ? 'tweet' : 'general');
  };

  const retry = () => {
    const history = turns.filter((t) => !(t.role === 'assistant' && !t.content));
    if (history.length) stream(action, history, request ? 'tweet' : 'general');
    else if (request) void startRun(action, request);
  };

  const lastIsStreamingAssistant =
    busy &&
    !status &&
    turns.length > 0 &&
    turns[turns.length - 1].role === 'assistant';

  // Minimized: just a floating launcher bubble in the corner (always present).
  if (!open) {
    return (
      <div className="cgx-root">
        <button
          className={`cgx-launcher${busy ? ' busy' : ''}`}
          style={{ bottom: `${launcherBottom}px` }}
          title="Ask Claude"
          onClick={() => setOpen(true)}
          dangerouslySetInnerHTML={{ __html: LOGO_SVG }}
        />
      </div>
    );
  }

  return (
    <div className="cgx-root">
      <div className="cgx-panel">
        <header className="cgx-header">
          <div className="cgx-brand">
            <span className="cgx-logo" dangerouslySetInnerHTML={{ __html: LOGO_SVG }} />
            <span className="cgx-title">Claude</span>
          </div>
          <div className="cgx-tools">
            {!general && (
              <div className="cgx-select-wrap">
                <select
                  className="cgx-select"
                  value={action}
                  onChange={(e) => onActionChange(e.target.value as ActionId)}
                >
                  {(Object.keys(ACTIONS) as ActionId[]).map((id) => (
                    <option key={id} value={id}>
                      {ACTIONS[id].label}
                    </option>
                  ))}
                </select>
                <span className="cgx-caret" aria-hidden>
                  ▾
                </span>
              </div>
            )}
            <button className="cgx-iconbtn" title="Settings" onClick={openOptions}>
              ⚙
            </button>
            <button className="cgx-iconbtn" title="Minimize" onClick={() => setOpen(false)}>
              –
            </button>
            <button className="cgx-iconbtn" title="Close" onClick={close}>
              ✕
            </button>
          </div>
        </header>

        <div className="cgx-body" ref={bodyRef}>
          {general && turns.length === 0 && !busy && !error && (
            <div className="cgx-empty">
              <span
                className="cgx-empty-logo"
                dangerouslySetInnerHTML={{ __html: LOGO_SVG }}
              />
              <p className="cgx-empty-title">Ask Claude anything</p>
              <p className="cgx-empty-sub">
                Current events, trends, or general questions. For a specific post, click
                the Claude button on any tweet.
              </p>
              <div className="cgx-chips">
                {GENERAL_PROMPTS.map((p) => (
                  <button key={p} className="cgx-chip" onClick={() => sendText(p)}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}
          {notice && <div className="cgx-notice">{notice}</div>}
          {turns.map((t, i) =>
            t.role === 'user' ? (
              <div key={i} className="cgx-turn-user">
                {t.display}
              </div>
            ) : (
              <div key={i} className="cgx-output">
                <span dangerouslySetInnerHTML={{ __html: renderMarkdown(t.display) }} />
                {lastIsStreamingAssistant && i === turns.length - 1 && (
                  <span className="cgx-cursor" />
                )}
              </div>
            ),
          )}
          {status && (
            <div className="cgx-status">
              <span className="cgx-dots">
                <i />
                <i />
                <i />
              </span>
              {status}
            </div>
          )}
          {error && (
            <div className="cgx-error">
              <p>{error}</p>
              <div className="cgx-error-actions">
                <button onClick={openOptions}>Open settings</button>
                <button onClick={retry}>Retry</button>
              </div>
            </div>
          )}
        </div>

        <footer className="cgx-footer">
          {meta && <div className="cgx-meta">{meta}</div>}
          <form
            className="cgx-inputrow"
            onSubmit={(e) => {
              e.preventDefault();
              sendText(input);
            }}
          >
            <input
              ref={inputRef}
              type="text"
              placeholder={
                busy
                  ? 'Claude is responding…'
                  : general
                    ? 'Ask Claude anything…'
                    : 'Ask a follow-up…'
              }
              value={input}
              disabled={busy}
              onChange={(e) => setInput(e.target.value)}
            />
            <button
              type="submit"
              className="cgx-send"
              disabled={busy || !input.trim()}
              title="Send"
            >
              ↑
            </button>
          </form>
        </footer>
      </div>
    </div>
  );
}
