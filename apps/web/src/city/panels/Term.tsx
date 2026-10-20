import { useId, useState, type ReactNode } from 'react';
import { GLOSSARY, type GlossaryKey } from '../glossary';

/**
 * A technical word with its plain explanation one click away: a small "?" button toggles the definition, which
 * screen readers reach through aria-controls. The definition stays in the DOM (hidden) so the reference is valid.
 */
export function Term({ k, children }: { k: GlossaryKey; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const g = GLOSSARY[k];
  return (
    <span className="term">
      {children}
      <button type="button" className="term__q" aria-expanded={open} aria-controls={id} aria-label={`What does “${g.term}” mean?`} title={g.text} onClick={() => setOpen(!open)} data-testid={`term-${k}`}>
        ?
      </button>
      <span id={id} className="term__def" hidden={!open} data-testid={`term-def-${k}`}>
        {g.text}
      </span>
    </span>
  );
}
