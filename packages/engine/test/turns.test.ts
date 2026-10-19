import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Edge, Graph, RouteStep, Vertex } from '../src/types.js';
import { mulberry32 } from '../src/examples/index.js';
import { decodeCityBundle, type CityModel } from '../src/city/index.js';
import { nearestNode, zoneCoverageGraph } from '../src/coverage/zone.js';
import { orderCoverageForTurns, solveZoneCoverage, type CoverageResult } from '../src/coverage/solveCoverage.js';
import { planFleet, type FleetPlan } from '../src/coverage/carp.js';
import { cityTurnOptions, orderForTurns, TurnModel, type TurnOptions } from '../src/coverage/turns.js';

const PEN = { straight: 0, left: 4, right: 10, uturn: 20 };
const key = (s: RouteStep): string => `${s.edgeId}:${s.from}>${s.to}`;
const multiset = (steps: readonly RouteStep[]): string[] => steps.map(key).sort();

/** Random connected graph on a grid of points; every edge driven both ways, in a random Euler order. */
function instance(seed: number): { graph: Graph; steps: RouteStep[]; depot: string } {
  const rnd = mulberry32(seed);
  const n = 3 + Math.floor(rnd() * 3);
  const vertices: Vertex[] = Array.from({ length: n }, (_, i) => ({ id: `v${i}`, x: Math.round(rnd() * 100), y: Math.round(rnd() * 100) }));
  const edges: Edge[] = [];
  for (let i = 1; i < n; i++) edges.push({ id: `e${edges.length}`, u: `v${Math.floor(rnd() * i)}`, v: `v${i}`, weight: 1 + Math.floor(rnd() * 9), required: true });
  const extra = Math.floor(rnd() * 2);
  for (let k = 0; k < extra; k++) {
    const u = Math.floor(rnd() * n);
    const v = (u + 1 + Math.floor(rnd() * (n - 1))) % n;
    edges.push({ id: `e${edges.length}`, u: `v${u}`, v: `v${v}`, weight: 1 + Math.floor(rnd() * 9), required: true });
  }
  // Random Euler circuit of the doubled edges (Hierholzer with random choices).
  const arcs: { e: Edge; from: string; to: string }[] = edges.flatMap((e) => [
    { e, from: e.u, to: e.v },
    { e, from: e.v, to: e.u },
  ]);
  const used = new Uint8Array(arcs.length);
  const stack: number[] = [];
  const circuit: number[] = [];
  const depot = 'v0';
  let at = depot;
  for (;;) {
    const opts = arcs.map((a, i) => i).filter((i) => !used[i] && arcs[i]!.from === at);
    if (opts.length) {
      const i = opts[Math.floor(rnd() * opts.length)]!;
      used[i] = 1;
      stack.push(i);
      at = arcs[i]!.to;
    } else {
      if (!stack.length) break;
      const i = stack.pop()!;
      circuit.push(i);
      at = arcs[i]!.from;
    }
  }
  circuit.reverse();
  let cum = 0;
  const steps = circuit.map((i, k) => {
    const a = arcs[i]!;
    cum += a.e.weight;
    return { index: k, edgeId: a.e.id, from: a.from, to: a.to, weight: a.e.weight, kind: 'service' as const, cumulative: cum };
  });
  return { graph: { vertices, edges }, steps, depot };
}

/** Best turn seconds and fewest banned turns over every order of the same traversals (exhaustive). */
function bruteForce(graph: Graph, steps: RouteStep[], depot: string, opts: TurnOptions): { seconds: number; banned: number; lex: [number, number] } {
  const model = new TurnModel(graph, opts);
  const used = new Uint8Array(steps.length);
  const order: RouteStep[] = [];
  let seconds = Infinity;
  let banned = Infinity;
  let lex: [number, number] = [Infinity, Infinity];
  const go = (at: string): void => {
    if (order.length === steps.length) {
      if (at !== depot) return;
      const t = model.tally(order);
      seconds = Math.min(seconds, t.seconds);
      banned = Math.min(banned, t.banned);
      if (t.banned < lex[0] || (t.banned === lex[0] && t.seconds < lex[1])) lex = [t.banned, t.seconds];
      return;
    }
    const seen = new Set<string>();
    for (let i = 0; i < steps.length; i++) {
      if (used[i] || steps[i]!.from !== at || seen.has(key(steps[i]!))) continue;
      seen.add(key(steps[i]!)); // identical traversals are interchangeable
      used[i] = 1;
      order.push(steps[i]!);
      go(steps[i]!.to);
      order.pop();
      used[i] = 0;
    }
  };
  go(depot);
  return { seconds, banned, lex };
}

describe('turn classification', () => {
  // City frame: x east, y south. Arriving eastbound at (10, 0).
  const graph: Graph = {
    vertices: [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 10, y: 0 },
      { id: 'c', x: 20, y: 0 },
      { id: 's', x: 10, y: 10 },
      { id: 'n', x: 10, y: -10 },
    ],
    edges: ['ab', 'bc', 'bs', 'bn'].map((id) => ({ id, u: id[0]!, v: id[1]!, weight: 10, required: true })),
  };
  const step = (edgeId: string, from: string, to: string): RouteStep => ({ index: 0, edgeId, from, to, weight: 10, kind: 'service', cumulative: 0 });
  const m = new TurnModel(graph, { penalties: PEN });
  it('straight, right (south), left (north) and U-turn', () => {
    expect(m.kind(step('ab', 'a', 'b'), step('bc', 'b', 'c'))).toBe('straight');
    expect(m.kind(step('ab', 'a', 'b'), step('bs', 'b', 's'))).toBe('right');
    expect(m.kind(step('ab', 'a', 'b'), step('bn', 'b', 'n'))).toBe('left');
    expect(m.kind(step('ab', 'a', 'b'), step('ab', 'b', 'a'))).toBe('uturn');
    expect(m.deadEnd('a')).toBe(true);
    expect(m.deadEnd('b')).toBe(false);
  });
});

describe('turn-aware order of a closed walk', () => {
  it('keeps every traversal, never adds penalty, and stays between the bound and the exhaustive optimum', () => {
    let optimalSeen = 0;
    let improved = 0;
    for (let seed = 1; seed <= 80; seed++) {
      const { graph, steps, depot } = instance(seed);
      const res = orderForTurns(graph, steps, depot, { penalties: PEN });
      expect(multiset(res.steps)).toEqual(multiset(steps));
      expect(res.steps[0]!.from).toBe(depot);
      expect(res.steps.at(-1)!.to).toBe(depot);
      for (let i = 0; i + 1 < res.steps.length; i++) expect(res.steps[i]!.to).toBe(res.steps[i + 1]!.from);
      expect(res.steps.at(-1)!.cumulative).toBeCloseTo(steps.at(-1)!.cumulative, 9);
      expect(res.after.seconds).toBeLessThanOrEqual(res.before.seconds);
      const best = bruteForce(graph, steps, depot, { penalties: PEN });
      expect(res.lowerBound.seconds).toBeLessThanOrEqual(best.seconds + 1e-9);
      expect(res.after.seconds).toBeGreaterThanOrEqual(best.seconds - 1e-9);
      if (res.optimal) {
        expect(res.after.seconds).toBeCloseTo(best.seconds, 9);
        optimalSeen++;
      }
      if (res.after.seconds < res.before.seconds) improved++;
    }
    // The instances are not all trivial: the bound is reached on some, and the order improves on many.
    expect(optimalSeen).toBeGreaterThan(10);
    expect(improved).toBeGreaterThan(20);
  });

  it('avoids banned turns where an order without them exists', () => {
    for (let seed = 200; seed < 260; seed++) {
      const { graph, steps, depot } = instance(seed);
      const rnd = mulberry32(seed * 7);
      const bannedSet = new Set<string>();
      for (const e of graph.edges) for (const f of graph.edges) for (const v of [e.u, e.v]) if (rnd() < 0.15 && (f.u === v || f.v === v)) bannedSet.add(`${e.id}|${v}|${f.id}`);
      const opts: TurnOptions = { penalties: PEN, banned: (a, via, b) => bannedSet.has(`${a}|${via}|${b}`) };
      const res = orderForTurns(graph, steps, depot, opts);
      const best = bruteForce(graph, steps, depot, opts);
      expect(multiset(res.steps)).toEqual(multiset(steps));
      expect(res.lowerBound.banned).toBeLessThanOrEqual(best.banned);
      expect(res.after.banned).toBeLessThanOrEqual(res.before.banned);
      // Banned turns weigh more than any penalty: never more banned turns than the original.
      expect(res.after.banned * 1e6 + res.after.seconds).toBeLessThanOrEqual(res.before.banned * 1e6 + res.before.seconds + 1e-9);
      if (res.optimal) expect([res.after.banned, res.after.seconds]).toEqual(best.lex);
    }
  });

  it('leaves a walk that is not closed at the depot unchanged', () => {
    const { graph, steps, depot } = instance(3);
    const open = steps.slice(0, -1);
    const res = orderForTurns(graph, open, depot, { penalties: PEN });
    expect(res.reordered).toBe(false);
    expect(res.steps.map(key)).toEqual(open.map(key));
  });
});

const BUNDLED = join(__dirname, '..', '..', '..', 'apps', 'web', 'public', 'cities', 'pune-bibwewadi.json');

describe.skipIf(!existsSync(BUNDLED))('turn-aware coverage on the real Pune network', () => {
  const city: CityModel = decodeCityBundle(JSON.parse(readFileSync(BUNDLED, 'utf8')));
  const c = city.focus!.xy;
  const zone = { kind: 'circle' as const, cx: c[0], cy: c[1], r: 600 };
  const depotId = `n${city.nodeOsm[nearestNode(city, c[0], c[1])]}`;
  const rules = cityTurnOptions(city, 'truck');

  for (const direction of ['directed', 'undirected'] as const) {
    it(`${direction}: same streets and length, fewer penalties, checks pass, bound holds`, () => {
      const zg = zoneCoverageGraph(city, { zone, direction, depotId });
      const cov = solveZoneCoverage(zg.graph, { direction, depotId }) as CoverageResult;
      expect(cov.ok).toBe(true);
      const t = orderCoverageForTurns(cov, rules);
      expect(t.turns.reordered).toBe(true);
      expect(multiset(t.route.steps)).toEqual(multiset(cov.route.steps));
      expect(t.route.totalDistance).toBe(cov.route.totalDistance);
      expect(t.route.serviceDistance).toBe(cov.route.serviceDistance);
      expect(t.route.deadheadDistance).toBe(cov.route.deadheadDistance);
      for (const ch of t.checks) expect(ch.passed, `${ch.id}: ${ch.detail}`).toBe(true);
      expect(t.turns.after.seconds).toBeLessThan(t.turns.before.seconds);
      expect(t.turns.after.uturn).toBeLessThanOrEqual(t.turns.before.uturn);
      expect(t.turns.lowerBound.seconds).toBeLessThanOrEqual(t.turns.after.seconds + 1e-9);
      expect(t.turns.after.banned).toBeLessThanOrEqual(t.turns.before.banned);
      // The tally the result reports is the tally of its steps.
      expect(new TurnModel(cov.graph, rules).tally(t.route.steps)).toEqual(t.turns.after);
    });
  }

  it('fleet: each route keeps its streets and length, the plan still verifies', () => {
    const zg = zoneCoverageGraph(city, { zone, direction: 'directed', depotId });
    const cov = solveZoneCoverage(zg.graph, { direction: 'directed', depotId }) as CoverageResult;
    const base = { vehicles: 3, depotId, direction: 'directed' as const, objective: 'min-makespan' as const, serviceSpeedKmh: 8, deadheadSpeedKmh: 20, coverage: cov };
    const plain = planFleet(cov.graph, base) as FleetPlan;
    const turned = planFleet(cov.graph, { ...base, turns: rules }) as FleetPlan;
    expect(plain.ok && turned.ok).toBe(true);
    expect(turned.validation.ok).toBe(true);
    expect(turned.routes.length).toBe(plain.routes.length);
    turned.routes.forEach((r, i) => {
      expect(multiset(r.steps)).toEqual(multiset(plain.routes[i]!.steps));
      expect(r.distance).toBe(plain.routes[i]!.distance);
      expect(r.seconds).toBe(plain.routes[i]!.seconds);
    });
    expect(turned.totals).toEqual(plain.totals);
    expect(turned.turns!.after.seconds).toBeLessThanOrEqual(turned.turns!.before.seconds);
    expect(turned.turns!.lowerBound!.seconds).toBeLessThanOrEqual(turned.turns!.after.seconds + 1e-9);
    expect(turned.turns!.reorderedRoutes + turned.turns!.keptRoutes).toBe(turned.routes.length);
    expect(plain.turns).toBeNull();
  });
});
