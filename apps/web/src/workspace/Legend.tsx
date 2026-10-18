import { useState } from 'react';

const ITEMS: Array<{ cls: string; label: string; explainOnly?: boolean }> = [
  { cls: 'required', label: 'Required street' },
  { cls: 'optional', label: 'Optional street' },
  { cls: 'route', label: 'Optimised route' },
  { cls: 'repeat', label: 'Repeated required street' },
  { cls: 'deadhead', label: 'Deadhead (optional, unserviced)' },
  { cls: 'odd', label: 'Odd-degree intersection' },
  { cls: 'match', label: 'Matched pair', explainOnly: true },
  { cls: 'depot', label: 'Route start' },
  { cls: 'tint', label: 'Separate required group' },
];

/** Compact horizontal legend at the top of the stage; every mark used on the canvas is explained. */
export function Legend({ explain }: { explain: boolean }) {
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 1500);
  return (
    <div className={`legend${open ? '' : ' is-collapsed'}`} role="region" aria-label="Legend">
      <button type="button" className="legend__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        Legend {open ? '−' : '+'}
      </button>
      {open && (
        <ul className="legend__list">
          {ITEMS.filter((i) => explain || !i.explainOnly).map((i) => (
            <li key={i.cls}>
              <span className={`lg lg--${i.cls}`} aria-hidden="true" /> {i.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
