/**
 * Shift timeline: a deterministic clock derived from a planned route. Every step
 * takes length / speed (service speed for first-time service, transit speed for
 * deadhead and repeat traversals), and every unloading adds a fixed pause. The
 * same plan and settings always give the same positions, and positions only move
 * forward as time increases.
 */

export interface TimelineRoute {
  /** 0 service, 1 repeat, 2 deadhead (as returned by the coverage worker). */
  kinds: Uint8Array;
  lengths: Float64Array;
  /** Step indices after which the vehicle unloads. */
  dumpAfterStep: readonly number[];
}

export interface TimelineSettings {
  serviceSpeedKmh: number;
  deadheadSpeedKmh: number;
  dumpSeconds: number;
}

export interface Schedule {
  /** Start and end time (s from shift start) of every step. */
  start: Float64Array;
  end: Float64Array;
  /** Cumulative service metres completed at the end of every step. */
  serviceDone: Float64Array;
  totalSeconds: number;
  serviceM: number;
}

export function buildSchedule(r: TimelineRoute, s: TimelineSettings): Schedule {
  const n = r.lengths.length;
  const start = new Float64Array(n);
  const end = new Float64Array(n);
  const serviceDone = new Float64Array(n);
  const dumps = new Set(r.dumpAfterStep);
  const vs = (s.serviceSpeedKmh * 1000) / 3600;
  const vd = (s.deadheadSpeedKmh * 1000) / 3600;
  let t = 0;
  let done = 0;
  for (let i = 0; i < n; i++) {
    start[i] = t;
    const service = r.kinds[i] === 0;
    t += r.lengths[i]! / (service ? vs : vd);
    if (service) done += r.lengths[i]!;
    end[i] = t;
    serviceDone[i] = done;
    if (dumps.has(i)) t += s.dumpSeconds;
  }
  return { start, end, serviceDone, totalSeconds: t, serviceM: done };
}

export interface Position {
  /** Step being driven (or the last step once finished); −1 before departure on an empty route. */
  step: number;
  /** Fraction of the current step travelled, 0…1. */
  frac: number;
  /** Unloading at the disposal site at this moment. */
  unloading: boolean;
  finished: boolean;
  /** Share of the vehicle's service distance completed, 0…1. */
  progress: number;
  /** Seconds until the vehicle is back at the depot. */
  remainingS: number;
}

/** Vehicle position at time t (s from shift start). Binary search; O(log n). */
export function positionAt(sc: Schedule, kinds: Uint8Array, lengths: Float64Array, t: number): Position {
  const n = sc.start.length;
  if (n === 0) return { step: -1, frac: 0, unloading: false, finished: true, progress: 1, remainingS: 0 };
  const tt = Math.max(0, t);
  if (tt >= sc.totalSeconds) return { step: n - 1, frac: 1, unloading: false, finished: true, progress: 1, remainingS: 0 };
  // Last step whose start ≤ t.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sc.start[mid]! <= tt) lo = mid;
    else hi = mid - 1;
  }
  const i = lo;
  const dur = sc.end[i]! - sc.start[i]!;
  const unloading = tt >= sc.end[i]!;
  const frac = unloading || dur <= 0 ? 1 : (tt - sc.start[i]!) / dur;
  const before = i > 0 ? sc.serviceDone[i - 1]! : 0;
  const doneM = before + (kinds[i] === 0 ? frac * lengths[i]! : 0);
  return { step: i, frac, unloading, finished: false, progress: sc.serviceM > 0 ? doneM / sc.serviceM : 1, remainingS: sc.totalSeconds - tt };
}

/** Clock label for a time of day given in seconds after midnight (wraps past 24 h). */
export function clockLabel(secondsOfDay: number): string {
  const s = ((Math.round(secondsOfDay) % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}
