import { useEffect, useId, useRef, useState } from 'react';
import { searchPlace, suggestPlaces, type GeoPlace } from '../lib/geocode';
import type { LngLat } from '../lib/directions';

export interface PlaceSearchProps {
  label: string;
  placeholder: string;
  /** Text shown for the chosen place. */
  value: string;
  onPick: (place: GeoPlace) => void;
  /** Where the map is looking, to rank nearby results first. */
  near: () => LngLat | null;
  dot?: 'from' | 'to' | null;
  active?: boolean;
  onFocus?: () => void;
  testId: string;
}

/** A search box with type-ahead place suggestions (combobox pattern). */
export function PlaceSearch({ label, placeholder, value, onPick, near, dot = null, active = false, onFocus, testId }: PlaceSearchProps) {
  const [text, setText] = useState(value);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<GeoPlace[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const listId = useId();
  const inputId = useId();
  const ctrl = useRef<AbortController | null>(null);
  const typed = useRef(false);

  useEffect(() => {
    setText(value);
    typed.current = false;
  }, [value]);

  useEffect(() => {
    if (!typed.current) return;
    const q = text.trim();
    if (q.length < 3 && !/^-?\d/.test(q)) {
      setOptions([]);
      setMessage(null);
      return;
    }
    const t = setTimeout(() => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setBusy(true);
      suggestPlaces(q, near(), c.signal)
        .then((places) => {
          if (c.signal.aborted) return;
          setOptions(places);
          setHighlight(0);
          setOpen(true);
          setMessage(places.length ? null : 'No suggestions. Press Enter to search, or click the map.');
        })
        .catch(() => undefined)
        .finally(() => !c.signal.aborted && setBusy(false));
    }, 250);
    return () => clearTimeout(t);
  }, [text, near]);

  const pick = (p: GeoPlace) => {
    setOpen(false);
    setOptions([]);
    setMessage(null);
    typed.current = false;
    setText(p.label);
    onPick(p);
  };

  const submit = async () => {
    if (open && options[highlight]) return pick(options[highlight]!);
    const q = text.trim();
    if (q.length < 2) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setBusy(true);
    try {
      const places = await searchPlace(q, near(), c.signal);
      if (places[0]) pick(places[0]);
      else setMessage(`Nothing found for "${q}".`);
    } catch (err) {
      if (!c.signal.aborted) setMessage(err instanceof Error ? err.message : 'Search failed.');
    } finally {
      if (!c.signal.aborted) setBusy(false);
    }
  };

  return (
    <div className={`place${active ? ' place--active' : ''}`} data-testid={testId}>
      {dot ? <span className={`place__dot place__dot--${dot}`} aria-hidden="true" /> : <span />}
      <label htmlFor={inputId} className="visually-hidden">
        {label}
      </label>
      <input
        id={inputId}
        className="input"
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-activedescendant={open && options[highlight] ? `${listId}-${highlight}` : undefined}
        placeholder={placeholder}
        value={text}
        autoComplete="off"
        data-testid={`${testId}-input`}
        onFocus={() => {
          onFocus?.();
          if (options.length) setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          typed.current = true;
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.min(h + 1, Math.max(0, options.length - 1)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(0, h - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      <span className="atlas__status" aria-live="polite">
        {busy ? '…' : ''}
      </span>
      {open && options.length > 0 && (
        <ul className="place__list" id={listId} role="listbox" aria-label={`${label} suggestions`}>
          {options.map((p, i) => (
            <li
              key={`${p.id}-${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === highlight}
              className="place__option"
              data-testid={`${testId}-option`}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(p);
              }}
            >
              <span className="place__label">{p.label}</span>
              {p.detail && <span className="place__detail">{p.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {message && (
        <p className="atlas__note" style={{ gridColumn: '2 / -1' }} role="status">
          {message}
        </p>
      )}
    </div>
  );
}
