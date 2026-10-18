import { useToasts } from '../state/toasts';

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span className="dot" aria-hidden="true" />
          <div>
            <strong>{t.title}</strong>
            {t.body ? <div className="muted" style={{ marginTop: 2 }}>{t.body}</div> : null}
          </div>
          <button className="btn btn--ghost btn--icon btn--sm" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
