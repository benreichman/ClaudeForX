import { useState } from 'react';
import type { FeedScope } from '@/utils/contextBuilder';
import { LOGO_SVG } from './logo';

const SCOPES: { id: FeedScope; label: string }[] = [
  { id: 'feed', label: 'Feed' },
  { id: 'person', label: 'Person' },
  { id: 'topic', label: 'Topic' },
];

interface Props {
  /** Whether the Feed access opt-in is enabled. */
  enabled: boolean;
  onCatchUp: (scope: FeedScope, arg: string) => void;
  onEnable: () => void;
  /** The demoted "or ask anything" example prompts. */
  prompts: string[];
  onAsk: (prompt: string) => void;
}

export function CatchUpCard({ enabled, onCatchUp, onEnable, prompts, onAsk }: Props) {
  const [scope, setScope] = useState<FeedScope>('feed');
  const [arg, setArg] = useState('');

  const needsArg = scope !== 'feed';
  const argReady = !needsArg || arg.trim().length > 0;

  const ctaLabel =
    scope === 'feed'
      ? 'Catch me up'
      : scope === 'person'
        ? `Catch me up on ${arg.trim() ? `@${arg.replace(/^@/, '').trim()}` : 'a person'}`
        : `Catch me up on ${arg.trim() ? `“${arg.trim()}”` : 'a topic'}`;

  const hint =
    scope === 'feed'
      ? 'recent · your feed'
      : scope === 'person'
        ? 'their recent posts'
        : 'top posts on X';

  const submit = () => {
    if (enabled && argReady) onCatchUp(scope, arg.trim());
  };

  return (
    <div className="cgx-empty">
      <span className="cgx-empty-logo" dangerouslySetInnerHTML={{ __html: LOGO_SVG }} />
      <p className="cgx-empty-title">Catch up on X</p>
      <p className="cgx-empty-sub">A quick read of what’s happening — no scrolling.</p>

      <div className="cgx-catchup-card">
        <div className="cgx-scope" role="tablist">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={scope === s.id}
              className={`cgx-scope-seg${scope === s.id ? ' active' : ''}`}
              onClick={() => setScope(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        {needsArg && (
          <input
            className="cgx-catchup-input"
            type="text"
            autoFocus
            value={arg}
            placeholder={scope === 'person' ? '@handle' : 'a topic, e.g. ai regulation'}
            onChange={(e) => setArg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        )}

        {enabled ? (
          <>
            <button
              type="button"
              className="cgx-catchup-cta"
              disabled={!argReady}
              onClick={submit}
            >
              <span className="cgx-catchup-glyph" dangerouslySetInnerHTML={{ __html: LOGO_SVG }} />
              {ctaLabel}
            </button>
            <span className="cgx-catchup-hint">{hint}</span>
          </>
        ) : (
          <div className="cgx-catchup-gate">
            <p>
              Reads your live X feed (or a person / topic) using your session — read-only,
              opt-in.
            </p>
            <button type="button" className="cgx-catchup-cta" onClick={onEnable}>
              Enable feed access
            </button>
          </div>
        )}
      </div>

      <div className="cgx-catchup-or">or ask anything</div>
      <div className="cgx-chips">
        {prompts.map((p) => (
          <button key={p} className="cgx-chip" onClick={() => onAsk(p)}>
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
