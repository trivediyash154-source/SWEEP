import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCityBundle } from '../src/city/decode.js';
import { reachability, rng, RoutingEngine, validateRoute, PROFILES, type AlgorithmId, type Objective, type RoutingGraph } from '../src/p2p/index.js';

const BUNDLE = join(__dirname, '..', '..', '..', 'apps', 'web', 'public', 'cities', 'pune-bibwewadi.json');
const ALGOS: AlgorithmId[] = ['dijkstra', 'astar', 'bidirectional', 'alt', 'ch'];
const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));

/** Nodes with at least one permitted arc leaving and one entering (otherwise every query is trivially unreachable). */
function candidates(g: RoutingGraph): number[] {
  const out: number[] = [];
  for (let n = 0; n < g.city.nodeCount; n++) if (g.nodeOutOff[n + 1]! > g.nodeOutOff[n]! && g.nodeInOff[n + 1]! > g.nodeInOff[n]!) out.push(n);
  return out;
}

describe.skipIf(!existsSync(BUNDLE))('point-to-point routing on the real Pune dataset (OpenStreetMap)', () => {
  const city = decodeCityBundle(JSON.parse(readFileSync(BUNDLE, 'utf8')));

  for (const profile of PROFILES) {
    for (const objective of ['time', 'distance'] as Objective[]) {
      it(`${profile}/${objective}: all algorithms agree on 200 random queries and every route validates`, () => {
        const e = new RoutingEngine(city, profile);
        const nodes = candidates(e.graph);
        expect(nodes.length).toBeGreaterThan(100);
        const r = rng(profile.length * 1000 + (objective === 'time' ? 1 : 2));
        let found = 0;
        for (let i = 0; i < 200; i++) {
          const q = { origin: nodes[Math.floor(r() * nodes.length)]!, destination: nodes[Math.floor(r() * nodes.length)]!, objective };
          const base = e.query('dijkstra', q).result;
          if (base.found) found++;
          for (const a of ALGOS) {
            const res = a === 'dijkstra' ? base : e.query(a, q).result;
            expect(res.found, `${a} found`).toBe(base.found);
            if (!res.found) continue;
            expect(rel(res.cost, base.cost), `${a} cost vs Dijkstra`).toBeLessThan(1e-9);
            const v = validateRoute(city, e.graph, q, res);
            expect(v.ok, `${a}: ${JSON.stringify(v.checks.filter((c) => !c.passed))}`).toBe(true);
          }
        }
        expect(found).toBeGreaterThan(100);
        expect(e.preprocessingStatus('alt', objective)).toMatchObject({ required: true, done: true });
        expect(e.preprocessingStatus('ch', objective)).toMatchObject({ required: true, done: true });
      }, 300_000);
    }
  }

  it('goal-directed searches expand fewer arcs than Dijkstra on average (same queries)', () => {
    const e = new RoutingEngine(city, 'car');
    const nodes = candidates(e.graph);
    const r = rng(42);
    const sum: Record<string, number> = { dijkstra: 0, astar: 0, alt: 0, ch: 0 };
    let n = 0;
    for (let i = 0; i < 100; i++) {
      const q = { origin: nodes[Math.floor(r() * nodes.length)]!, destination: nodes[Math.floor(r() * nodes.length)]!, objective: 'time' as const };
      const d = e.query('dijkstra', q).result;
      if (!d.found) continue;
      n++;
      for (const a of ['dijkstra', 'astar', 'alt', 'ch'] as const) sum[a]! += e.query(a, q).result.expanded;
    }
    expect(n).toBeGreaterThan(30);
    expect(sum.astar!).toBeLessThan(sum.dijkstra!);
    expect(sum.alt!).toBeLessThan(sum.dijkstra!);
    expect(sum.ch!).toBeLessThan(sum.dijkstra!);
  }, 300_000);

  it('reachability from the focus point is monotone and consistent with Dijkstra', () => {
    const e = new RoutingEngine(city, 'car');
    const fx = city.focus?.xy ?? [0, 0];
    let origin = 0;
    let best = Infinity;
    for (const n of candidates(e.graph)) {
      const d = Math.hypot(city.nodeX[n]! - fx[0], city.nodeY[n]! - fx[1]);
      if (d < best) {
        best = d;
        origin = n;
      }
    }
    const res = reachability(e.graph, origin, [300, 600, 900]);
    expect(res.levels.map((l) => l.thresholdS)).toEqual([300, 600, 900]);
    for (let i = 1; i < 3; i++) {
      const prev = new Set(Array.from(res.levels[i - 1]!.fullArcs));
      for (const a of prev) expect(res.levels[i]!.fullArcs.includes(a)).toBe(true);
      expect(res.levels[i]!.nodes).toBeGreaterThanOrEqual(res.levels[i - 1]!.nodes);
    }
    expect(res.levels[0]!.nodes).toBeGreaterThan(1);
    const r = rng(9);
    for (let i = 0; i < 40; i++) {
      const t = Math.floor(r() * city.nodeCount);
      const arr = res.nodeArrivalS[t]!;
      if (!Number.isFinite(arr) || t === origin) continue;
      const d = e.query('dijkstra', { origin, destination: t, objective: 'time' }).result;
      expect(rel(arr, d.cost)).toBeLessThan(1e-9);
    }
  }, 120_000);

  it('applies the dataset turn restrictions that bind each profile', () => {
    const car = new RoutingEngine(city, 'car');
    const foot = new RoutingEngine(city, 'foot');
    expect(car.graph.stats.restrictionsApplied + car.graph.stats.restrictionsNotApplicable).toBe(city.restrictions.length);
    expect(foot.graph.stats.restrictionsApplied).toBe(0);
  });
});
