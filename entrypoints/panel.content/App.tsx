import { useCallback, useEffect, useRef, useState } from 'react';
import { gatherContext, gatherProfileContext } from '@/utils/contextBuilder';
import { renderMarkdown } from '@/utils/markdown';
import { panelBus, type OpenRequest } from '@/utils/panelBus';
import { ACTIONS } from '@/utils/prompts';
import { getSettings, saveSettings } from '@/utils/settings';
import { executeTool } from '@/utils/xTools';
import { ModelPicker } from './ModelPicker';
import type {
  ActionId,
  ApiImageBlock,
  ChatMessage,
  RunRequest,
  StreamMessage,
  ToolCard,
  WebSource,
} from '@/utils/types';
import {
  deleteSession,
  listSessions,
  newSessionId,
  saveSession,
  titleFromTurns,
  type ChatSession,
  type StoredTurn,
} from '@/utils/sessions';
import { LOGO_SVG } from './logo';
import {
  ICON_CLOCK,
  ICON_CLOSE,
  ICON_MINUS,
  ICON_PLUS,
  ICON_SETTINGS,
  ICON_TRASH,
} from './icons';
import { SourcesStrip, ToolCardView } from './ToolCards';

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

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
// Returns the `bottom` offset to clear X's Grok FAB, or null if that button
// isn't in the DOM yet (X's SPA renders it after load — caller should retry).
function computeLauncherBottom(): number | null {
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
  if (topMost === null) return null;
  return Math.max(20, Math.round(window.innerHeight - topMost + gap));
}

/** A chat turn: `content` is what goes to the API, `display` what we render.
 * They differ only for the first user turn, whose content embeds the whole
 * captured thread but displays as just the action label. */
interface Turn extends ChatMessage {
  content: string;
  display: string;
  /** Images attached to this turn (only the first user turn carries them). */
  images?: ApiImageBlock[];
  /** Tool-call cards (web/X) rendered inline on an assistant turn. */
  tools?: ToolCard[];
  /** Cited web sources shown as a strip under an assistant turn. */
  sources?: WebSource[];
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
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [model, setModel] = useState<string>('claude-sonnet-4-6');
  // Panel expanded vs. minimized to the launcher bubble. Closed by default, so
  // the launcher is present on every X page (always-on mode).
  const [open, setOpen] = useState(false);
  // null until we've located X's Grok FAB — the launcher stays hidden until then
  // so it never flashes at the wrong spot.
  const [launcherBottom, setLauncherBottom] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null);

  // No `request` = general (no-tweet) chat mode.
  const general = request === null;

  const portRef = useRef<Port | null>(null);
  const actionRef = useRef<ActionId>('explain');
  actionRef.current = action;
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Session bookkeeping (refs so async stream callbacks see live values).
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const sessionIdRef = useRef<string | null>(null);
  const sessionCreatedRef = useRef<number>(0);
  const sessionModeRef = useRef<'tweet' | 'general'>('general');

  function beginSession(mode: 'tweet' | 'general'): void {
    sessionIdRef.current = newSessionId();
    sessionCreatedRef.current = Date.now();
    sessionModeRef.current = mode;
  }

  function persistCurrent(): void {
    const live = turnsRef.current.filter(
      (t) => t.content || (t.tools && t.tools.length),
    );
    if (!live.length || !sessionIdRef.current) return;
    const storedTurns: StoredTurn[] = live.map((t) => ({
      role: t.role,
      content: t.content,
      display: t.display,
      tools: t.tools,
      sources: t.sources,
    }));
    void saveSession({
      id: sessionIdRef.current,
      title: titleFromTurns(storedTurns),
      mode: sessionModeRef.current,
      createdAt: sessionCreatedRef.current || Date.now(),
      updatedAt: Date.now(),
      turns: storedTurns,
    });
  }

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

  // Load the current model once (for the footer quick-switcher).
  useEffect(() => {
    void getSettings().then((s) => setModel(s.model));
  }, []);

  const onModelChange = (m: string) => {
    setModel(m);
    void saveSettings({ model: m });
  };

  // Show an "Ask Claude" popover when the user selects text anywhere on X.
  // Driven by `selectionchange` (fires reliably on document) rather than mouseup,
  // which X sometimes intercepts. Debounced so it settles after the drag ends.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const evaluate = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      if (!sel || sel.rangeCount === 0 || text.length < 2 || text.length > 8000) {
        setSelection(null);
        return;
      }
      const rects = sel.getRangeAt(0).getClientRects();
      const rect = rects[rects.length - 1] ?? sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) {
        setSelection(null);
        return;
      }
      setSelection({
        text,
        x: Math.min(Math.max(8, rect.right - 60), window.innerWidth - 150),
        y: Math.min(rect.bottom + 8, window.innerHeight - 48),
      });
    };
    const onSelChange = () => {
      clearTimeout(timer);
      timer = setTimeout(evaluate, 180);
    };
    document.addEventListener('selectionchange', onSelChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onSelChange);
    };
  }, []);

  // While minimized, position the launcher above X's bottom-right Grok FAB.
  // That FAB renders + animates in after page load, so poll quickly and wait
  // for a STABLE reading (same value twice) before showing — this avoids the
  // flash at the default corner and the mid-animation jump.
  useEffect(() => {
    if (open) return;
    const STEP = 100;
    let last: number | null = null;
    let stable = 0;
    let elapsed = 0;
    const poll = setInterval(() => {
      elapsed += STEP;
      const b = computeLauncherBottom();
      if (b != null) {
        if (b === last) stable += 1;
        else {
          last = b;
          stable = 0;
        }
        if (stable >= 1) {
          setLauncherBottom(b); // settled
          clearInterval(poll);
          return;
        }
      }
      if (elapsed >= 2500) {
        // No (stable) FAB found — fall back so the launcher still appears.
        setLauncherBottom((prev) => prev ?? b ?? 20);
        clearInterval(poll);
      }
    }, STEP);
    const onResize = () => {
      const b = computeLauncherBottom();
      if (b != null) setLauncherBottom(b);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearInterval(poll);
      window.removeEventListener('resize', onResize);
    };
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
    // Patch the trailing assistant turn (where streamed content/cards land).
    const patchLast = (fn: (t: Turn) => Turn) =>
      setTurns((prev) => {
        if (!prev.length) return prev;
        const next = [...prev];
        next[next.length - 1] = fn(next[next.length - 1]);
        return next;
      });

    portRef.current = port;
    port.onMessage.addListener((raw: unknown) => {
      const m = raw as StreamMessage;
      if (m.type === 'delta') {
        setStatus('');
        patchLast((last) => ({
          ...last,
          content: last.content + m.text,
          display: last.display + m.text,
        }));
      } else if (m.type === 'status') {
        setStatus(m.text);
      } else if (m.type === 'web-search-start') {
        patchLast((last) => ({
          ...last,
          tools: [...(last.tools ?? []), { kind: 'web', query: m.query, running: true, results: [] }],
        }));
      } else if (m.type === 'web-search-results') {
        patchLast((last) => {
          const tools = [...(last.tools ?? [])];
          // Update the most recent still-running web card.
          for (let i = tools.length - 1; i >= 0; i--) {
            const c = tools[i];
            if (c.kind === 'web' && c.running) {
              tools[i] = { ...c, running: false, results: m.results };
              break;
            }
          }
          return { ...last, tools };
        });
      } else if (m.type === 'web-sources') {
        patchLast((last) => ({ ...last, sources: m.sources }));
      } else if (m.type === 'tool-exec') {
        // The worker is asking us to run a client tool (X session access).
        void executeTool(m.name, m.input).then(({ content, card }) => {
          patchLast((last) => ({ ...last, tools: [...(last.tools ?? []), card] }));
          try {
            port.postMessage({ type: 'tool-result', id: m.id, content });
          } catch {
            // port closed — ignore
          }
        });
      } else if (m.type === 'done') {
        setStatus('');
        setBusy(false);
        portRef.current = null;
        persistCurrent();
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

  /** Start a fresh "who is this?" conversation for a profile. */
  const startProfileRun = useCallback(
    async (handle: string) => {
      disconnectPort();
      beginSession('general');
      setTurns([]);
      setError(null);
      setNotice(null);
      setBusy(true);
      setStatus('Reading the profile…');
      const ctx = await gatherProfileContext(handle, setStatus);
      setMeta(`@${handle} · profile`);
      const first: Turn = {
        role: 'user',
        content: `Below is @${handle}'s X profile — their bio and a sample of their most recent posts, fetched live from X just now for this question (the user did not paste them). Based on it, give me a quick read on who they are, what they mostly post about, and their apparent stance/vibe. These posts are current, so there's no need to fetch more. Keep it tight.\n\n${ctx}`,
        display: `Who is @${handle}?`,
      };
      stream(actionRef.current, [first], 'general');
    },
    [stream, disconnectPort],
  );

  /** Start a fresh conversation for a tweet with the given action. */
  const startRun = useCallback(
    async (act: ActionId, req: Extract<OpenRequest, { kind: 'tweet' }>) => {
      disconnectPort();
      beginSession('tweet');
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
      if (req.kind === 'tweet') void startRun(actionRef.current, req);
      else void startProfileRun(req.handle);
    });
  }, [startRun, startProfileRun]);

  // Fully reset to a general, empty chat and minimize.
  const close = () => {
    disconnectPort();
    persistCurrent();
    setRequest(null);
    setTurns([]);
    setNotice(null);
    setMeta('');
    setError(null);
    setBusy(false);
    setShowHistory(false);
    sessionIdRef.current = null;
    setOpen(false);
  };

  const newChat = () => {
    disconnectPort();
    persistCurrent();
    sessionIdRef.current = null;
    setRequest(null);
    setTurns([]);
    setNotice(null);
    setMeta('');
    setError(null);
    setBusy(false);
    setShowHistory(false);
  };

  const openHistory = async () => {
    persistCurrent();
    setSessions(await listSessions());
    setShowHistory(true);
  };

  const openSession = (s: ChatSession) => {
    disconnectPort();
    persistCurrent();
    sessionIdRef.current = s.id;
    sessionCreatedRef.current = s.createdAt;
    sessionModeRef.current = s.mode;
    setRequest(null);
    setTurns(
      s.turns.map((t) => ({
        role: t.role,
        content: t.content,
        display: t.display,
        tools: t.tools,
        sources: t.sources,
      })),
    );
    setNotice(null);
    setMeta('');
    setError(null);
    setBusy(false);
    setShowHistory(false);
  };

  const removeSession = async (id: string) => {
    await deleteSession(id);
    setSessions(await listSessions());
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
    if (request?.kind === 'tweet') void startRun(value, request);
  };

  /** Append a user message and stream a reply (works in both modes). */
  const sendText = (raw: string) => {
    const text = raw.trim();
    if (!text || busy) return;
    if (!sessionIdRef.current) beginSession(general ? 'general' : 'tweet');
    setInput('');
    // Drop any empty assistant turn left behind by an errored run.
    const history = turns.filter((t) => !(t.role === 'assistant' && !t.content));
    stream(action, [...history, { role: 'user', content: text, display: text }], sessionModeRef.current);
  };

  const retry = () => {
    const history = turns.filter((t) => !(t.role === 'assistant' && !t.content));
    if (history.length) stream(action, history, sessionModeRef.current);
    else if (request?.kind === 'tweet') void startRun(action, request);
  };

  // Abort the in-flight response, keeping whatever streamed so far.
  const stopGenerating = () => {
    disconnectPort();
    setStatus('');
    setBusy(false);
    persistCurrent();
  };

  // Re-run the last user turn, replacing the last assistant response.
  const regenerate = () => {
    const lastUser = turns.map((t) => t.role).lastIndexOf('user');
    if (lastUser < 0) return;
    stream(action, turns.slice(0, lastUser + 1), sessionModeRef.current);
  };

  // Open a fresh general chat asking about the selected text.
  const askSelection = () => {
    if (!selection) return;
    const text = selection.text.slice(0, 4000);
    setSelection(null);
    disconnectPort();
    setRequest(null);
    setTurns([]);
    setError(null);
    setNotice(null);
    setMeta('');
    sessionIdRef.current = null;
    beginSession('general');
    setOpen(true);
    const short = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    stream(
      action,
      [
        {
          role: 'user',
          content: `Explain this text I selected on X. Give context on what it means and why it matters:\n\n"""${text}"""`,
          display: `Explain: "${short}"`,
        },
      ],
      'general',
    );
  };

  const copyMessage = (text: string, i: number) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedIdx(i);
      setTimeout(() => setCopiedIdx((c) => (c === i ? null : c)), 1500);
    });
  };

  const lastIsStreamingAssistant =
    busy &&
    !status &&
    turns.length > 0 &&
    turns[turns.length - 1].role === 'assistant';

  // Minimized: a floating launcher bubble (hidden until positioned above X's
  // Grok FAB) plus the select-to-ask popover when text is highlighted.
  if (!open) {
    return (
      <div className="cgx-root">
        {launcherBottom != null && (
          <button
            className={`cgx-launcher${busy ? ' busy' : ''}`}
            style={{ bottom: `${launcherBottom}px` }}
            title="Ask Claude"
            onClick={() => setOpen(true)}
            dangerouslySetInnerHTML={{ __html: LOGO_SVG }}
          />
        )}
        {selection && (
          <button
            className="cgx-sel-pop"
            style={{ left: `${selection.x}px`, top: `${selection.y}px` }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={askSelection}
          >
            <span
              className="cgx-sel-logo"
              dangerouslySetInnerHTML={{ __html: LOGO_SVG }}
            />
            Ask Claude
          </button>
        )}
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
            <button
              className="cgx-iconbtn"
              title="New chat"
              onClick={newChat}
              dangerouslySetInnerHTML={{ __html: ICON_PLUS }}
            />
            <button
              className="cgx-iconbtn"
              title="History"
              onClick={() => void openHistory()}
              dangerouslySetInnerHTML={{ __html: ICON_CLOCK }}
            />
            <button
              className="cgx-iconbtn"
              title="Settings"
              onClick={openOptions}
              dangerouslySetInnerHTML={{ __html: ICON_SETTINGS }}
            />
            <button
              className="cgx-iconbtn"
              title="Minimize"
              onClick={() => setOpen(false)}
              dangerouslySetInnerHTML={{ __html: ICON_MINUS }}
            />
            <button
              className="cgx-iconbtn"
              title="Close"
              onClick={close}
              dangerouslySetInnerHTML={{ __html: ICON_CLOSE }}
            />
          </div>
        </header>

        {request?.kind === 'tweet' && (
          <div className="cgx-actionbar">
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
          </div>
        )}

        {showHistory && (
          <div className="cgx-history">
            <div className="cgx-history-head">
              <span>Chat history</span>
              <button
                className="cgx-iconbtn"
                title="Back"
                onClick={() => setShowHistory(false)}
                dangerouslySetInnerHTML={{ __html: ICON_CLOSE }}
              />
            </div>
            <div className="cgx-history-list">
              {sessions.length === 0 && (
                <div className="cgx-history-empty">No saved chats yet.</div>
              )}
              {sessions.map((s) => (
                <div key={s.id} className="cgx-history-row">
                  <button className="cgx-history-open" onClick={() => openSession(s)}>
                    <span className="cgx-history-title">
                      {s.mode === 'tweet' ? '𝕏 ' : ''}
                      {s.title}
                    </span>
                    <span className="cgx-history-time">{relativeTime(s.updatedAt)}</span>
                  </button>
                  <button
                    className="cgx-iconbtn"
                    title="Delete"
                    onClick={() => void removeSession(s.id)}
                    dangerouslySetInnerHTML={{ __html: ICON_TRASH }}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

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
                {t.tools?.map((card, ci) => <ToolCardView key={ci} card={card} />)}
                <span dangerouslySetInnerHTML={{ __html: renderMarkdown(t.display) }} />
                {lastIsStreamingAssistant && i === turns.length - 1 && (
                  <span className="cgx-cursor" />
                )}
                {t.sources && t.sources.length > 0 && <SourcesStrip sources={t.sources} />}
                {t.content && !(busy && i === turns.length - 1) && (
                  <div className="cgx-msg-actions">
                    <button onClick={() => copyMessage(t.display, i)}>
                      {copiedIdx === i ? 'Copied' : 'Copy'}
                    </button>
                    {i === turns.length - 1 && !busy && (
                      <button onClick={regenerate}>Regenerate</button>
                    )}
                  </div>
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
          <div className="cgx-footmeta">
            <ModelPicker value={model} onChange={onModelChange} />
            {meta && <span className="cgx-meta">{meta}</span>}
          </div>
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
            {busy ? (
              <button
                type="button"
                className="cgx-send cgx-stop"
                title="Stop"
                onClick={stopGenerating}
              >
                <span className="cgx-stop-sq" />
              </button>
            ) : (
              <button
                type="submit"
                className="cgx-send"
                disabled={!input.trim()}
                title="Send"
              >
                ↑
              </button>
            )}
          </form>
        </footer>
      </div>
    </div>
  );
}
