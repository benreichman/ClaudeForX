import { useEffect, useRef, useState } from 'react';
import { MODELS } from '@/utils/settings';

const name = (label: string): string => label.split('—')[0].trim();
const desc = (label: string): string => label.split('—')[1]?.trim() ?? '';

/** A small but clearly-labeled model dropdown (opens upward from the footer). */
export function ModelPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = MODELS.find((m) => m.id === value) ?? MODELS[0];

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  return (
    <div className="cgx-mp" ref={ref}>
      <button
        className="cgx-mp-btn"
        onClick={() => setOpen((o) => !o)}
        title="Choose model"
      >
        <span className="cgx-mp-spark">✳</span>
        <span className="cgx-mp-cur">{name(current.label)}</span>
        <span className="cgx-mp-caret">▾</span>
      </button>
      {open && (
        <div className="cgx-mp-menu">
          <div className="cgx-mp-head">Model</div>
          {MODELS.map((m) => (
            <button
              key={m.id}
              className={`cgx-mp-item${m.id === value ? ' active' : ''}`}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span className="cgx-mp-name">{name(m.label)}</span>
              {desc(m.label) && <span className="cgx-mp-desc">{desc(m.label)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
