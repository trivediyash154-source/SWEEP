import { describe, expect, it } from 'vitest';
import type { DirectedOptimizationRecord, Edge, Graph, OptimizationFailure } from '../src/index.js';
import { minCostFlow, shortestCoveringWalk, solveChinesePostman, solveDirectedPostman, verifyDirectedRoute, verifyFlowOptimality, validateGraph } from '../src/index.js';
import { mulberry32 } from '../src/examples/index.js';
import { randomGraph } from './helpers.js';

const V = (...ids: string[]) => ids.map((id, i) => ({ id, x: i * 100, y: (i % 2) * 80 }));
const oneway = (id: string, u: string, v: string, weight: number, required = true): Edge => ({ id, u, v, weight, required, oneway: true });
const twoway = (id: string, u: string, v: string, weight: number, required = true, reverseWeight?: number): Edge => ({
  id,
  u,
  v,
  weight,
  required,
  ...(reverseWeight !== undefined ? { reverseWeight } : {}),
});

function solved(g: Graph, opts: Parameters<typeof solveDirectedPostman>[1] = {}): DirectedOptimizationRecord {
  const r = solveDirectedPostman(g, opts);
  if (!r.ok) throw new Error(`expected a solution, got ${JSON.stringify(r.validation.issues.filter((i) => i.severity === 'error'))}`);
  expect(r.checks.every((c) => c.passed), JSON.stringify(r.checks.filter((c) => !c.passed))).toBe(true);
  expect(r.algorithm.optimal).toBe(true);
  return r;
}

function errorCodes(r: ReturnType<typeof solveDirectedPostman>): string[] {
  expect(r.ok).toBe(false);
  return (r as OptimizationFailure).validation.issues.filter((i) => i.severity === 'error').map((i) => i.code);
}

describe('directed Chinese Postman: hand-verifiable networks', () => {
  it('a directed Eulerian cycle needs no augmentation', () => {
    const g: Graph = { vertices: V('a', 'b', 'c'), edges: [oneway('ab', 'a', 'b', 1), oneway('bc', 'b', 'c', 2), oneway('ca', 'c', 'a', 3)], depotId: 'a' };
    const r = solved(g);
    expect(r.route.totalDistance).toBe(6);
    expect(r.imbalancedVertexIds).toEqual([]);
    expect(r.flow.paths).toEqual([]);
    expect(r.algorithm.balancing).toBe('none');
    expect(r.route.steps.map((s) => `${s.from}${s.to}`)).toEqual(['ab', 'bc', 'ca']);
    expect(r.flow.crossCheckCost).toBe(6);
  });

  it('imbalanced vertices are balanced by shortest legal paths', () => {
    // a has two required departures and no arrival (δ = −2); c two arrivals (δ = +2).
    const g: Graph = {
      vertices: V('a', 'b', 'c'),
      edges: [oneway('ab', 'a', 'b', 4), oneway('bc', 'b', 'c', 3), oneway('ac', 'a', 'c', 2), oneway('ca', 'c', 'a', 1, false)],
      depotId: 'a',
    };
    const r = solved(g);
    expect(r.balance.find((b) => b.vertexId === 'a')!.delta).toBe(-2);
    expect(r.balance.find((b) => b.vertexId === 'c')!.delta).toBe(2);
    expect(r.flow.paths).toEqual([expect.objectContaining({ from: 'c', to: 'a', units: 2, distance: 1, pathEdgeIds: ['ca'] })]);
    expect(r.flow.cost).toBe(2);
    expect(r.route.totalDistance).toBe(11);
    expect(r.route.deadheadTraversals).toBe(2);
  });

  it('finds a non-trivial optimal augmentation that greedy balancing misses', () => {
    // Surplus s1, s2; deficit t1, t2. Greedy joins the closest pair (s1→t1, 1) and is then
    // forced into s2→t2 (7); the optimum crosses over: s1→t2 (2) + s2→t1 (2).
    const g: Graph = {
      vertices: V('s1', 's2', 't1', 't2'),
      edges: [
        oneway('t1s1', 't1', 's1', 5),
        oneway('t2s2', 't2', 's2', 5),
        oneway('s1s2', 's1', 's2', 5),
        oneway('s2s1', 's2', 's1', 5),
        oneway('s1t1', 's1', 't1', 1, false),
        oneway('s1t2', 's1', 't2', 2, false),
        oneway('s2t1', 's2', 't1', 2, false),
        oneway('s2t2', 's2', 't2', 10, false),
      ],
      depotId: 's1',
    };
    const r = solved(g);
    expect(r.flow.cost).toBe(4);
    expect(r.route.totalDistance).toBe(24);
    expect(r.baselines.find((b) => b.id === 'greedy-balancing')!.total).toBe(28);
    expect(r.flow.crossCheckCost).toBe(24);
    expect(r.flow.dualCertificateVerified).toBe(true);
    const pairs = r.flow.paths.map((p) => `${p.from}->${p.to}`).sort();
    expect(pairs).toEqual(['s1->t2', 's2->t1']);
  });

  it('rejects a one-way dead end: entering is possible, leaving is not', () => {
    const g: Graph = { vertices: V('a', 'b', 'c'), edges: [twoway('ab', 'a', 'b', 2), oneway('bc', 'b', 'c', 3)], depotId: 'a' };
    const r = solveDirectedPostman(g);
    expect(errorCodes(r)).toEqual(['DIRECTED_INFEASIBLE']);
    const issue = (r as OptimizationFailure).validation.issues.find((i) => i.code === 'DIRECTED_INFEASIBLE')!;
    expect(issue.message).toMatch(/no legal way back/);
    expect(issue.edgeIds).toContain('bc');
    expect(shortestCoveringWalk(g, { depotId: 'a', twoWay: 'both' })).toBeNull();
  });

  it('rejects required streets that cannot be reached legally from the start', () => {
    const g: Graph = { vertices: V('a', 'b', 'c'), edges: [twoway('ab', 'a', 'b', 2), oneway('cb', 'c', 'b', 3)], depotId: 'a' };
    const issue = (solveDirectedPostman(g) as OptimizationFailure).validation.issues.find((i) => i.code === 'DIRECTED_INFEASIBLE')!;
    expect(issue.message).toMatch(/cannot be reached/);
  });

  it('still rejects disconnected required streets (directed rural postman is NP-hard)', () => {
    const g: Graph = {
      vertices: V('a', 'b', 'c', 'd'),
      edges: [oneway('ab', 'a', 'b', 1), oneway('ba', 'b', 'a', 1), oneway('bc', 'b', 'c', 1, false), oneway('cb', 'c', 'b', 1, false), oneway('cd', 'c', 'd', 1), oneway('dc', 'd', 'c', 1)],
      depotId: 'a',
    };
    expect(errorCodes(solveDirectedPostman(g))).toEqual(['REQUIRED_DISCONNECTED']);
  });

  it('uses asymmetric travel costs per direction', () => {
    // One two-way street, uphill 10 and downhill 4.
    const g: Graph = { vertices: V('a', 'b'), edges: [twoway('ab', 'a', 'b', 10, true, 4)], depotId: 'a' };
    const both = solved(g, { twoWay: 'both' });
    expect(both.route.totalDistance).toBe(14);
    expect(both.route.steps.map((s) => s.weight)).toEqual([10, 4]);
    const either = solved(g, { twoWay: 'either' });
    expect(either.route.totalDistance).toBe(14);
    // A triangle where the cheap orientation matters: either-direction service picks the downhill loop.
    const tri: Graph = {
      vertices: V('a', 'b', 'c'),
      edges: [twoway('ab', 'a', 'b', 9, true, 1), twoway('bc', 'b', 'c', 9, true, 1), twoway('ca', 'c', 'a', 9, true, 1)],
      depotId: 'a',
    };
    const t = solved(tri, { twoWay: 'either' });
    expect(t.route.totalDistance).toBe(3);
    expect(t.route.steps.map((s) => `${s.from}${s.to}`)).toEqual(['ac', 'cb', 'ba']);
    expect(t.algorithm.orientationSearch).toEqual({ twoWayRequired: 3, orientationsEvaluated: 8 });
    expect(t.flow.crossCheckCost).toBe(3);
  });

  it('a route that is optimal when one-way rules are ignored breaks them; the directed route does not', () => {
    // a→b is one-way. Undirected, the path a–b–c is doubled and b→a is driven against traffic.
    const g: Graph = {
      vertices: V('a', 'b', 'c'),
      edges: [oneway('ab', 'a', 'b', 1), twoway('bc', 'b', 'c', 1), oneway('ca', 'c', 'a', 5, false)],
      depotId: 'a',
    };
    const strict = solveChinesePostman(g);
    expect(strict.ok).toBe(false);
    expect((strict as OptimizationFailure).validation.issues.map((i) => i.code)).toContain('ONEWAY_REQUIRES_DIRECTED');
    const relaxed = solveChinesePostman(g, { ignoreOneway: true });
    if (!relaxed.ok) throw new Error('relaxation should solve');
    expect(relaxed.algorithm.directionPolicy).toBe('oneway-ignored');
    expect(relaxed.route.totalDistance).toBe(4);
    expect(relaxed.route.wrongWayTraversals).toBeGreaterThan(0);
    expect(relaxed.checks.find((c) => c.id === 'direction')!.passed).toBe(false);
    expect(relaxed.algorithm.optimalityBasis).toMatch(/relaxation/);

    const either = solved(g, { twoWay: 'either' });
    expect(either.route.totalDistance).toBe(7);
    expect(either.checks.find((c) => c.id === 'direction')!.passed).toBe(true);
    const both = solved(g, { twoWay: 'both' });
    expect(both.route.totalDistance).toBe(9);
    // Independent verification of the relaxed route against the real directions fails.
    const v = verifyDirectedRoute(g, relaxed.route.steps, { depotId: 'a', twoWay: 'either' });
    expect(v.checks.find((c) => c.id === 'direction')!.passed).toBe(false);
  });

  it('refuses large either-direction instances instead of approximating', () => {
    const vertices = V(...Array.from({ length: 14 }, (_, i) => `v${i}`));
    const edges = Array.from({ length: 14 }, (_, i) => twoway(`e${i}`, `v${i}`, `v${(i + 1) % 14}`, 1));
    expect(errorCodes(solveDirectedPostman({ vertices, edges }, { twoWay: 'either' }))).toEqual(['MIXED_TOO_LARGE']);
    // "Both directions" has no such limit.
    expect(solved({ vertices, edges }, { twoWay: 'both' }).route.totalDistance).toBe(28);
  });

  it('is deterministic', () => {
    const g = randomMixed(77, 7, 12)!;
    const a = solveDirectedPostman(g);
    const b = solveDirectedPostman(g);
    expect(JSON.stringify({ ...a, timingsMs: null })).toEqual(JSON.stringify({ ...b, timingsMs: null }));
  });
});

describe('minimum-cost flow', () => {
  it('certifies optimality and detects a tampered certificate', () => {
    const arcs = [
      { tail: 0, head: 1, cost: 1 },
      { tail: 0, head: 2, cost: 4 },
      { tail: 1, head: 2, cost: 1 },
      { tail: 2, head: 3, cost: 1 },
    ];
    const supply = [2, 0, 0, -2];
    const f = minCostFlow(4, arcs, supply);
    expect(f.feasible).toBe(true);
    expect(f.cost).toBe(6);
    expect(verifyFlowOptimality(4, arcs, supply, f.flow, f.potential).ok).toBe(true);
    // A suboptimal flow (sending both units along the expensive arc) fails the certificate.
    expect(verifyFlowOptimality(4, arcs, supply, [0, 2, 0, 2], f.potential).ok).toBe(false);
  });
  it('reports infeasibility when supply cannot reach demand', () => {
    const f = minCostFlow(3, [{ tail: 1, head: 0, cost: 1 }], [1, 0, -1]);
    expect(f.feasible).toBe(false);
    expect(f.stranded).toEqual([0]);
  });
});

/** Random small network with one-way streets and asymmetric reverse costs. */
function randomMixed(seed: number, maxN: number, maxM: number): Graph | null {
  const rnd = mulberry32(seed);
  const base = randomGraph(seed, { maxN, maxM, optionalProb: 0.3, loops: seed % 4 === 0 });
  base.edges = base.edges.map((e) => {
    const r = rnd();
    if (r < 0.35) return { ...e, oneway: true };
    if (r < 0.55) return { ...e, reverseWeight: Math.floor(rnd() * 15) };
    return e;
  });
  return base;
}

function obligations(g: Graph, twoWay: 'both' | 'either'): number {
  return g.edges.filter((e) => e.required).reduce((s, e) => s + (twoWay === 'both' && !e.oneway && e.u !== e.v ? 2 : 1), 0);
}

describe('directed and mixed solver vs independent state-space search', () => {
  for (const twoWay of ['both', 'either'] as const) {
    it(`matches the exhaustive optimum on random one-way networks (${twoWay})`, () => {
      let solvedCount = 0;
      let infeasible = 0;
      for (let seed = 1; seed <= 700; seed++) {
        const g = randomMixed(seed, 6, 8)!;
        if (obligations(g, twoWay) > 10) continue;
        const r = solveDirectedPostman(g, { twoWay });
        const structural = validateGraph(g, { onewayPolicy: 'directed' });
        if (!r.ok) {
          const codes = r.validation.issues.filter((i) => i.severity === 'error').map((i) => i.code);
          expect(codes.every((c) => ['NO_REQUIRED_EDGES', 'REQUIRED_DISCONNECTED', 'REQUIRED_UNREACHABLE', 'DIRECTED_INFEASIBLE'].includes(c)), `seed ${seed} ${codes}`).toBe(true);
          if (codes.includes('DIRECTED_INFEASIBLE')) {
            infeasible++;
            const depot = g.edges.find((e) => e.required)!.u;
            expect(shortestCoveringWalk(g, { depotId: depot, twoWay }), `seed ${seed}`).toBeNull();
          }
          continue;
        }
        expect(structural.ok).toBe(true);
        solvedCount++;
        const ex = shortestCoveringWalk(g, { depotId: r.input.depotId, twoWay });
        expect(ex, `seed ${seed}`).not.toBeNull();
        expect(r.route.totalDistance, `seed ${seed}`).toBeCloseTo(ex!, 9);
        expect(r.checks.every((c) => c.passed), `seed ${seed}: ${JSON.stringify(r.checks.filter((c) => !c.passed))}`).toBe(true);
        for (const b of r.baselines) if (b.isValidRoute && b.total !== null) expect(b.total).toBeGreaterThanOrEqual(r.route.totalDistance - 1e-9);
      }
      expect(solvedCount).toBeGreaterThan(150);
      expect(infeasible).toBeGreaterThan(10);
    });
  }

  it('with every street two-way and symmetric, "either direction" equals the undirected optimum', () => {
    let compared = 0;
    for (let seed = 3000; seed < 3400; seed++) {
      const g = randomGraph(seed, { maxN: 7, maxM: 10 });
      if (g.edges.filter((e) => e.required).length > 12) continue;
      const u = solveChinesePostman(g);
      const d = solveDirectedPostman(g, { twoWay: 'either' });
      expect(u.ok, `seed ${seed}`).toBe(d.ok);
      if (!u.ok || !d.ok) continue;
      compared++;
      expect(d.route.totalDistance, `seed ${seed}`).toBeCloseTo(u.route.totalDistance, 9);
    }
    expect(compared).toBeGreaterThan(150);
  });
});

describe('shortestPathBetween', () => {
  it('respects one-way streets only in directed mode', async () => {
    const { shortestPathBetween } = await import('../src/index.js');
    const g: Graph = { vertices: V('a', 'b', 'c'), edges: [oneway('ab', 'a', 'b', 1), twoway('bc', 'b', 'c', 2), twoway('ca', 'c', 'a', 10)] };
    expect(shortestPathBetween(g, 'b', 'a', false)).toEqual({ distance: 1, vertexIds: ['b', 'a'], edgeIds: ['ab'] });
    expect(shortestPathBetween(g, 'b', 'a', true)).toEqual({ distance: 12, vertexIds: ['b', 'c', 'a'], edgeIds: ['bc', 'ca'] });
  });
});
