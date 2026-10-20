import { describe, expect, it } from 'vitest';
import { exhaustiveOptimalTotal, solveChinesePostman, validateGraph, verifyRoute } from '../src/index.js';
import { randomGraph } from './helpers.js';

describe('solver vs exhaustive search on random multigraphs', () => {
  it('matches the exhaustive optimum and passes every invariant (1,200 graphs)', () => {
    let solved = 0;
    let rejected = 0;
    for (let seed = 1; seed <= 1200; seed++) {
      const g = randomGraph(seed, { maxN: 7, maxM: 11, loops: seed % 3 === 0 });
      const r = solveChinesePostman(g);
      if (!r.ok) {
        rejected++;
        const codes = r.validation.issues.filter((i) => i.severity === 'error').map((i) => i.code);
        expect(codes.length).toBeGreaterThan(0);
        expect(codes.every((c) => ['NO_REQUIRED_EDGES', 'REQUIRED_DISCONNECTED', 'REQUIRED_UNREACHABLE'].includes(c))).toBe(true);
        continue;
      }
      solved++;
      const ex = exhaustiveOptimalTotal(g, 1);
      expect(ex, `seed ${seed}`).not.toBeNull();
      expect(r.route.totalDistance, `seed ${seed}`).toBeCloseTo(ex!.total, 9);
      expect(r.checks.every((c) => c.passed), `seed ${seed}: ${JSON.stringify(r.checks.filter((c) => !c.passed))}`).toBe(true);
      expect(r.algorithm.optimal).toBe(true);
      const v = verifyRoute(g, r.route.steps, { depotId: r.input.depotId, expectedTotal: r.route.totalDistance });
      expect(v.ok).toBe(true);
      // Greedy baseline is a valid route, so it can never beat the optimum.
      const greedy = r.baselines.find((b) => b.id === 'greedy-pairing')!;
      expect(greedy.total!).toBeGreaterThanOrEqual(r.route.totalDistance - 1e-9);
      expect(r.route.totalDistance).toBeGreaterThanOrEqual(r.route.requiredDistance - 1e-9);
    }
    expect(solved).toBeGreaterThan(500);
    expect(rejected).toBeGreaterThan(0);
  });

  it('never needs more than one extra copy of an edge (exhaustive over {0,1,2} copies)', () => {
    for (let seed = 5000; seed < 5250; seed++) {
      const g = randomGraph(seed, { maxN: 6, maxM: 8 });
      if (!validateGraph(g).ok) continue;
      const one = exhaustiveOptimalTotal(g, 1)!;
      const two = exhaustiveOptimalTotal(g, 2)!;
      expect(one.total, `seed ${seed}`).toBeCloseTo(two.total, 9);
    }
  });

  it('is deterministic: identical input gives an identical route', () => {
    const g = randomGraph(77, { maxN: 7, maxM: 11 });
    const a = solveChinesePostman(g);
    const b = solveChinesePostman(structuredClone(g));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.route.steps).toEqual(b.route.steps);
      expect(a.input.graphHash).toBe(b.input.graphHash);
    }
  });
});
