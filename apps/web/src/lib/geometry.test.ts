import { describe, expect, it } from 'vitest';
import { solveChinesePostman } from '@sweep/engine';
import { getExample } from '@sweep/engine/examples';
import { buildRouteGeometry, sampleRoute } from './geometry';

describe('route geometry', () => {
  it('maps animation progress onto true route distance without teleporting', () => {
    const g = getExample('konigsberg')!.graph;
    const r = solveChinesePostman(g);
    if (!r.ok) throw new Error('solve failed');
    const geo = buildRouteGeometry(g, r.route.steps);
    expect(sampleRoute(geo, 0).distance).toBe(0);
    expect(sampleRoute(geo, geo.totalDrawn).distance).toBeCloseTo(r.route.totalDistance, 6);
    // consecutive samples are spatially close (continuous path) and distance is monotone
    let prev = sampleRoute(geo, 0);
    const n = 2000;
    for (let i = 1; i <= n; i++) {
      const cur = sampleRoute(geo, (geo.totalDrawn * i) / n);
      expect(cur.distance).toBeGreaterThanOrEqual(prev.distance - 1e-9);
      const jump = Math.hypot(cur.point[0] - prev.point[0], cur.point[1] - prev.point[1]);
      expect(jump).toBeLessThan((geo.totalDrawn / n) * 1.5 + 1e-6);
      prev = cur;
    }
  });
});
