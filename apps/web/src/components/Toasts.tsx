import { useEffect, useRef } from 'react';
import { useToasts, type Toast } from '../state/toasts';

/** Longest interval credited per tick: time the main thread spends blocked (e.g. building a large district) does not count as time on screen. */
const MAX_TICK_MS = 250;

function ToastItem({ t, onDismiss }: { t: Toast; onDismiss: () => void }) {
  const paused = useRef(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (t.ttlMs <= 0) return;
    let shown = 0;
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      if (!paused.current && document.visibilityState === 'visible') shown += Math.min(now - last, MAX_TICK_MS);
      last = now;
      if (shown >= t.ttlMs) dismissRef.current();
    }, 200);
    return () => window.clearInterval(timer);
  }, [t.ttlMs]);
  const pause = () => {
    paused.current = true;
  };
  const resume = () => {
    paused.current = false;
  };
  return (
    <div className={`toast toast--${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'} onMouseEnter={pause} onMouseLeave={resume} onFocus={pause} onBlur={resume}>
      <span className="dot" aria-hidden="true" />
      <div>
        <strong>{t.title}</strong>
        {t.body ? <div className="muted" style={{ marginTop: 2 }}>{t.body}</div> : null}
      </div>
      <button className="btn btn--ghost btn--icon btn--sm" onClick={onDismiss} aria-label="Dismiss notification">
        ×
      </button>
    </div>
  );
}

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <ToastItem key={t.id} t={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}
