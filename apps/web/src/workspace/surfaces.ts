/** The working surfaces of the workspace, in page order. */
export const SURFACES = [
  { id: 'simulation', key: 'B', label: 'Simulation' },
  { id: 'projection', key: 'C', label: 'Projection' },
  { id: 'mathematics', key: 'D', label: 'Mathematics' },
  { id: 'laboratory', key: 'E', label: 'Laboratory' },
  { id: 'editor', key: 'F', label: 'Editor' },
  { id: 'verification', key: 'G', label: 'Verification' },
  { id: 'history', key: 'H', label: 'History' },
  { id: 'export', key: 'I', label: 'Export' },
] as const;

export type SurfaceId = (typeof SURFACES)[number]['id'];

export function scrollToSurface(id: SurfaceId): void {
  const el = document.getElementById(`surface-${id}`);
  if (!el) return;
  const reduce = document.documentElement.getAttribute('data-motion') === 'reduced' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  const heading = el.querySelector<HTMLElement>('h1, h2');
  heading?.setAttribute('tabindex', '-1');
  heading?.focus({ preventScroll: true });
}
