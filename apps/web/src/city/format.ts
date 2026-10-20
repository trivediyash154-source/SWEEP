/** Display formats shared by the city panels. */

export const fmtDist = (m: number): string => (!Number.isFinite(m) ? '–' : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

/** m:ss below an hour, "h h m min" above. Rounded once to whole seconds, so 59.6 s carries into the next minute. */
export const fmtTime = (s: number): string => {
  if (!Number.isFinite(s)) return '–';
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const r = total - m * 60;
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m}:${String(r).padStart(2, '0')} min`;
};
