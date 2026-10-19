import { describe, expect, it } from 'vitest';
import { solveChinesePostman, type Graph, type RouteStep } from '@sweep/engine';
import { getExample } from '@sweep/engine/examples';
import { buildTrack, drawnAtDistance, sampleTrack } from './routeTrack';

describe('route track', () => {
  it('is parameterised by true route distance and never teleports beyond a lane change', () => {
    const g = getExample('riverside-ladder')!.graph;
    const r = solveChinesePostman(g);
    if (!r.ok) throw new Error('solve failed');
    const lane = 4;
    const track = buildTrack(g, r.route.steps, { laneWidth: lane });
    expect(track.total).toBeCloseTo(r.route.totalDistance, 9);
    expect(track.cumDist).toHaveLength(r.route.steps.length + 1);
    expect(sampleTrack(track, 0).distance).toBe(0);
    expect(sampleTrack(track, track.total).distance).toBeCloseTo(r.route.totalDistance, 9);
    // The engine route repeats a street, so a second lane exists.
    const maxPass = Math.max(...track.pass);
    expect(maxPass).toBeGreaterThanOrEqual(1);
    // Moving between lanes at a step boundary is the only allowed discontinuity.
    const laneJump = 2 * lane * (0.55 + maxPass * 0.95);
    const n = 3000;
    let prev = sampleTrack(track, 0);
    let prevDrawn = 0;
    for (let i = 1; i <= n; i++) {
      const d = (track.total * i) / n;
      const cur = sampleTrack(track, d);
      const drawn = drawnAtDistance(track, d);
      expect(cur.distance).toBeGreaterThanOrEqual(prev.distance);
      expect(drawn).toBeGreaterThanOrEqual(prevDrawn - 1e-9);
      const jump = Math.hypot(cur.point[0] - prev.point[0], cur.point[1] - prev.point[1]);
      const stride = (track.totalDrawn / n) * 2;
      expect(jump).toBeLessThan(cur.stepIndex === prev.stepIndex ? stride + 1e-6 : stride + laneJump);
      prev = cur;
      prevDrawn = drawn;
    }
    expect(drawnAtDistance(track, track.total)).toBeCloseTo(track.totalDrawn, 9);
  });

  it('offsets each traversal to the right of travel, one lane further out per earlier pass', () => {
    // One street from (0,0) east to (100,0); map y grows downwards (south).
    const g: Graph = {
      name: 'lanes',
      vertices: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 100, y: 0 },
      ],
      edges: [{ id: 'e', u: 'a', v: 'b', weight: 100, required: true }],
    };
    const steps: RouteStep[] = [
      { edgeId: 'e', from: 'a', to: 'b', weight: 100, cumulative: 100, kind: 'service' },
      { edgeId: 'e', from: 'b', to: 'a', weight: 100, cumulative: 200, kind: 'repeat' },
      { edgeId: 'e', from: 'a', to: 'b', weight: 100, cumulative: 300, kind: 'repeat' },
    ] as RouteStep[];
    const track = buildTrack(g, steps, { laneWidth: 10 });
    expect(track.pass).toEqual([0, 1, 2]);
    const mid = (k: number) => sampleTrack(track, track.cumDist[k]! + 50).point;
    // Eastbound: right is south (+y). Westbound: right is north (-y).
    expect(mid(0)[1]).toBeCloseTo(5.5, 6);
    expect(mid(1)[1]).toBeCloseTo(-15, 6);
    expect(mid(2)[1]).toBeCloseTo(24.5, 6);
    // Without a lane width every traversal lies on the centreline.
    const flat = buildTrack(g, steps);
    expect(sampleTrack(flat, 150).point[1]).toBe(0);
  });
});
