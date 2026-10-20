export function RouteFallback() {
  return (
    <div className="route-fallback" role="status" aria-live="polite">
      <span className="route-fallback__mark spectral-text">SWEEP</span>
      <span className="visually-hidden">Loading…</span>
    </div>
  );
}
