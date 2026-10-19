import { describe, expect, it } from 'vitest';
import { buildSchedule, clockLabel, positionAt } from './timeline';

const route = {
  kinds: Uint8Array.from([0, 2, 0, 1]),
  lengths: Float64Array.from([800, 1000, 400, 500]),
  dumpAfterStep: [1],
};
const settings = { serviceSpeedKmh: 8, deadheadSpeedKmh: 20, dumpSeconds: 600 };

describe('shift timeline', () => {
  it('times every step from its length and speed, plus unloading pauses', () => {
    const sc = buildSchedule(route, settings);
    // 800 m at 8 km/h = 360 s; 1000 m at 20 km/h = 180 s; unload 600 s; 400 m at 8 km/h = 180 s; 500 m at 20 km/h = 90 s.
    expect(Array.from(sc.start)).toEqual([0, 360, 1140, 1320]);
    expect(Array.from(sc.end)).toEqual([360, 540, 1320, 1410]);
    expect(sc.totalSeconds).toBe(1410);
    expect(sc.serviceM).toBe(1200);
  });

  it('is deterministic and moves only forward in time', () => {
    const sc = buildSchedule(route, settings);
    let prevStep = -1;
    let prevFrac = 0;
    let prevProgress = 0;
    for (let t = 0; t <= 1500; t += 7) {
      const a = positionAt(sc, route.kinds, route.lengths, t);
      const b = positionAt(buildSchedule(route, settings), route.kinds, route.lengths, t);
      expect(b).toEqual(a);
      expect(a.step > prevStep || (a.step === prevStep && a.frac >= prevFrac - 1e-12)).toBe(true);
      expect(a.progress).toBeGreaterThanOrEqual(prevProgress - 1e-12);
      expect(a.remainingS).toBeGreaterThanOrEqual(0);
      prevStep = a.step;
      prevFrac = a.frac;
      prevProgress = a.progress;
    }
  });

  it('reports unloading, progress and completion at known instants', () => {
    const sc = buildSchedule(route, settings);
    expect(positionAt(sc, route.kinds, route.lengths, 180)).toMatchObject({ step: 0, frac: 0.5, progress: 400 / 1200 });
    expect(positionAt(sc, route.kinds, route.lengths, 800)).toMatchObject({ step: 1, unloading: true, progress: 800 / 1200 });
    expect(positionAt(sc, route.kinds, route.lengths, 1410)).toMatchObject({ finished: true, progress: 1, remainingS: 0 });
  });

  it('formats a time of day', () => {
    expect(clockLabel(6 * 3600 + 1410)).toBe('06:23');
    expect(clockLabel(25 * 3600)).toBe('01:00');
  });
});
