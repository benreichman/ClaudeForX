import { useEffect, useRef, useState } from 'react';

export interface ModelOption {
  id: string;
  name: string;
  desc?: string;
}

/** A small but clearly-labeled model dropdown (opens upward from the footer). */
export function ModelPicker({
  options,
  value,
  onChange,
}: {
  options: ModelOption[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((m) => m.id === value) ?? options[0];

  // Close on outside click. Use composedPath() so clicks inside our shadow-DOM
  // menu register as "inside" (e.target is retargeted to the shadow host).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (ref.current && !e.composedPath().includes(ref.current)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  if (!options.length) return null;

  return (
    <div className="cgx-mp" ref={ref}>
      <button className="cgx-mp-btn" onClick={() => setOpen((o) => !o)} title="Choose model">
        <span className="cgx-mp-spark">✳</span>
        <span className="cgx-mp-cur">{current?.name ?? value}</span>
        <span className="cgx-mp-caret">▾</span>
      </button>
      {open && (
        <div className="cgx-mp-menu">
          <div className="cgx-mp-head">Model</div>
          {options.map((m) => (
            <button
              key={m.id}
              className={`cgx-mp-item${m.id === value ? ' active' : ''}`}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span className="cgx-mp-name">{m.name}</span>
              {m.desc && <span className="cgx-mp-desc">{m.desc}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
