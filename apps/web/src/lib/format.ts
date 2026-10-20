/** Distance formatting. Values are in metres (the bundled examples' unit). */
export function formatDistance(m: number, opts: { precise?: boolean } = {}): string {
  if (!Number.isFinite(m)) return '—';
  if (opts.precise || Math.abs(m) < 1000) return `${formatNumber(m, m % 1 === 0 ? 0 : 1)} m`;
  return `${formatNumber(m / 1000, 2)} km`;
}

export function formatNumber(x: number, digits = 0): string {
  return x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
