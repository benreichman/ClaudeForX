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

/** A chat turn: `content` is what goes to the API, `display` what we render.
 * They differ only for the first user turn, whose content embeds the whole
 * captured thread but displays as just the action label. */
interface Turn extends ChatMessage {
  content: string;
  display: string;
  /** Images attached to this turn (only the first user turn carries them). */
  images?: ApiImageBlock[];
}

function bodyIsDark(): boolean {
  const m = getComputedStyle(document.body)
    .backgroundColor.match(/(\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return false;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
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
  const [dark, setDark] = useState(false);

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

  /** Stream a completion for `messages`, appending into a fresh assistant turn. */
  const stream = useCallback((act: ActionId, messages: Turn[]) => {
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
    const runMsg: RunRequest = { type: 'run', action: act, messages: apiMessages };
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
      stream(act, [first]);
    },
    [stream, disconnectPort],
  );

  useEffect(() => {
    return panelBus.onOpen((req) => {
      setDark(bodyIsDark());
      setRequest(req);
      void startRun(actionRef.current, req);
    });
  }, [startRun]);

  if (!request) return null;

  const close = () => {
    disconnectPort();
    setRequest(null);
    setTurns([]);
    setBusy(false);
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
    void startRun(value, request);
  };

  const sendFollowUp = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    // Drop any empty assistant turn left behind by an errored run.
    const history = turns.filter((t) => !(t.role === 'assistant' && !t.content));
    stream(action, [...history, { role: 'user', content: text, display: text }]);
  };

  const retry = () => {
    const history = turns.filter((t) => !(t.role === 'assistant' && !t.content));
    if (history.length) stream(action, history);
    else void startRun(action, request);
  };

  return (
    <div className={`cgx-root${dark ? ' dark' : ''}`}>
      <div className="cgx-panel">
        <header className="cgx-header">
          <span
            className="cgx-logo"
            dangerouslySetInnerHTML={{ __html: LOGO_SVG }}
          />
          <span className="cgx-title">Claude</span>
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
          <button className="cgx-iconbtn" title="Settings" onClick={openOptions}>
            ⚙
          </button>
          <button className="cgx-iconbtn" title="Close" onClick={close}>
            ✕
          </button>
        </header>

        <div className="cgx-body" ref={bodyRef}>
          {notice && <div className="cgx-notice">{notice}</div>}
          {turns.map((t, i) =>
            t.role === 'user' ? (
              <div key={i} className="cgx-turn-user">
                {t.display}
              </div>
            ) : (
              <div
                key={i}
                className="cgx-output"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(t.display) }}
              />
            ),
          )}
          {status && <div className="cgx-status">{status}</div>}
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
          {meta && <div className="cgx-meta">Context: {meta}</div>}
          <form
            className="cgx-inputrow"
            onSubmit={(e) => {
              e.preventDefault();
              sendFollowUp();
            }}
          >
            <input
              ref={inputRef}
              type="text"
              placeholder={busy ? 'Claude is responding…' : 'Ask a follow-up…'}
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
