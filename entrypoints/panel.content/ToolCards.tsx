import { useState } from 'react';
import type { ToolCard, WebSource } from '@/utils/types';

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function Favicon({ url }: { url: string }) {
  const host = hostnameOf(url);
  if (!host) return null;
  return (
    <img
      className="cgx-favicon"
      src={`https://www.google.com/s2/favicons?domain=${host}&sz=32`}
      alt=""
      loading="lazy"
    />
  );
}

const WEB_ICON = '🌐';
const X_ICON = '𝕏';

export function ToolCardView({ card }: { card: ToolCard }) {
  const [open, setOpen] = useState(false);

  const count = card.kind === 'web' ? card.results.length : card.tweets.length;
  const running = card.kind === 'web' && card.running;
  const expandable = count > 0;

  const title = card.kind === 'web' ? 'Web search' : card.label;
  const subtitle = card.kind === 'web' ? card.query : card.query ?? card.label;

  return (
    <div className="cgx-tool">
      <button
        className="cgx-tool-head"
        disabled={!expandable}
        onClick={() => expandable && setOpen((o) => !o)}
      >
        <span className="cgx-tool-icon">{card.kind === 'web' ? WEB_ICON : X_ICON}</span>
        <span className="cgx-tool-meta">
          <span className="cgx-tool-label">
            {running ? 'Searching…' : title}
            {!running && count > 0 && <span className="cgx-tool-count"> · {count}</span>}
          </span>
          {subtitle && <span className="cgx-tool-sub">{subtitle}</span>}
        </span>
        {expandable && <span className={`cgx-tool-chevron${open ? ' open' : ''}`}>▾</span>}
      </button>

      {open && card.kind === 'web' && (
        <ol className="cgx-tool-list">
          {card.results.map((r, i) => (
            <li key={`${r.url}-${i}`}>
              <a href={r.url} target="_blank" rel="noopener noreferrer">
                <span className="cgx-tool-num">{i + 1}</span>
                <Favicon url={r.url} />
                <span className="cgx-tool-host">{hostnameOf(r.url)}</span>
                <span className="cgx-tool-title">{r.title}</span>
              </a>
            </li>
          ))}
        </ol>
      )}

      {open && card.kind === 'x' && (
        <ol className="cgx-tool-list">
          {card.tweets.map((t, i) => (
            <li key={`${t.url}-${i}`}>
              <a href={t.url} target="_blank" rel="noopener noreferrer">
                <span className="cgx-tool-num">{i + 1}</span>
                <span className="cgx-tool-tweet">
                  <span className="cgx-tool-host">@{t.handle}</span>
                  <span className="cgx-tool-tweettext">{t.text}</span>
                  {t.likes != null && <span className="cgx-tool-likes">♥ {t.likes}</span>}
                </span>
              </a>
            </li>
          ))}
        </ol>
      )}

      {card.kind === 'x' && card.note && count === 0 && (
        <div className="cgx-tool-note">{card.note}</div>
      )}
    </div>
  );
}

export function SourcesStrip({ sources }: { sources: WebSource[] }) {
  if (!sources.length) return null;
  return (
    <div className="cgx-sources">
      <div className="cgx-sources-head">Sources</div>
      <div className="cgx-sources-chips">
        {sources.map((s, i) => (
          <a
            key={`${s.url}-${i}`}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            title={s.title}
          >
            <span className="cgx-tool-num">{i + 1}</span>
            <Favicon url={s.url} />
            <span className="cgx-tool-host">{hostnameOf(s.url)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
