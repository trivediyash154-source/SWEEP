import { describe, expect, it } from 'vitest';
import {
  buildRoutingGraph,
  classifyTurn,
  parseMaxspeed,
  profileAssumptions,
  randomGridCity,
  reachability,
  rng,
  RoutingEngine,
  speedFor,
  syntheticCity,
  transitionIndex,
  validateRoute,
  PROFILE_SPECS,
  PROFILES,
  type AlgorithmId,
  type Objective,
  type RoutingGraph,
} from '../src/p2p/index.js';

const ALGOS: AlgorithmId[] = ['dijkstra', 'astar', 'bidirectional', 'alt', 'ch'];
const OBJECTIVES: Objective[] = ['time', 'distance'];
const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Independent reference: Bellman–Ford over the transitions, written separately
 * from the engine's searches (no heap, no heuristics, no shared code beyond the
 * graph arrays). Costs come straight from arc times/lengths and turn penalties.
 */
function referenceCost(g: RoutingGraph, origin: number, dest: number, objective: Objective): number {
  if (origin === dest) return 0;
  const A = g.arcCount;
  const cost = (a: number): number => (objective === 'time' ? g.arcTime[a]! : g.arcLen[a]!);
  const d = new Float64Array(A).fill(Infinity);
  for (let a = 0; a < A; a++) if (g.arcAllowed[a] && g.arcTail[a] === origin) d[a] = cost(a);
  for (let iter = 0; iter < A; iter++) {
    let changed = false;
    for (let a = 0; a < A; a++) {
      if (d[a] === Infinity) continue;
      for (let k = g.outOff[a]!; k < g.outOff[a + 1]!; k++) {
        const b = g.outTo[k]!;
        const nd = d[a]! + (objective === 'time' ? g.outPen[k]! : 0) + cost(b);
        if (nd < d[b]!) {
          d[b] = nd;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  let best = Infinity;
  for (let a = 0; a < A; a++) if (g.arcHead[a] === dest && d[a]! < best) best = d[a]!;
  return best;
}

// --- hand-checkable networks (metres; x east, y SOUTH) ---------------------------------
/** A(0,0) → B(100,0) one-way; a two-way detour A–B through (50,80). */
const onewayCity = () =>
  syntheticCity({
    nodes: [
      [0, 0],
      [100, 0],
    ],
    segments: [
      { u: 0, v: 1, oneway: true },
      { u: 0, v: 1, shape: [[50, 80]] },
    ],
  });

/** T junction at node 1 with a diagonal bypass 2–3. */
const tJunction = (restrictions: Parameters<typeof syntheticCity>[0]['restrictions'] = []) =>
  syntheticCity({
    nodes: [
      [0, 0],
      [100, 0],
      [200, 0],
      [100, 100],
    ],
    segments: [
      { u: 0, v: 1 },
      { u: 1, v: 2 },
      { u: 1, v: 3 },
      { u: 2, v: 3 },
    ],
    restrictions,
  });

describe('profiles', () => {
  it('parses maxspeed strictly and applies it per profile', () => {
    expect(parseMaxspeed('40')).toBe(40);
    expect(parseMaxspeed('40 km/h')).toBe(40);
    expect(parseMaxspeed('30 mph')).toBeCloseTo(48.28, 2);
    expect(parseMaxspeed('IN:urban')).toBeNull();
    expect(parseMaxspeed('none')).toBeNull();
    expect(parseMaxspeed('40;50')).toBeNull();
    const way = { id: 1, highway: 'residential', maxspeed: '40' };
    expect(speedFor(way, PROFILE_SPECS.car)).toEqual({ kmh: 40, source: 'maxspeed' });
    expect(speedFor(way, PROFILE_SPECS.truck)).toEqual({ kmh: 40, source: 'maxspeed' });
    expect(speedFor(way, PROFILE_SPECS.bicycle)).toEqual({ kmh: 14, source: 'default' });
    expect(speedFor({ id: 1, highway: 'residential', maxspeed: '10' }, PROFILE_SPECS.bicycle)).toEqual({ kmh: 10, source: 'maxspeed' });
    expect(speedFor(way, PROFILE_SPECS.foot)).toEqual({ kmh: 4.8, source: 'default' });
    expect(speedFor({ id: 1, highway: 'residential', maxspeed: '120' }, PROFILE_SPECS.truck).kmh).toBe(60);
  });
  it('classifies turns for left-hand traffic in a y-south frame', () => {
    // Heading east (+x), turning to heading north (−y in the y-south frame) is a LEFT turn.
    expect(classifyTurn(1, 0, 0, -1)).toBe('left');
    expect(classifyTurn(1, 0, 0, 1)).toBe('right');
    expect(classifyTurn(1, 0, 1, 0.1)).toBe('straight');
  });
  it('states every assumption and limitation', () => {
    for (const p of PROFILES) {
      const a = profileAssumptions(p).join(' ');
      expect(a).toMatch(/assumptions/);
      expect(a).toMatch(/no live or time-of-day traffic/);
    }
    expect(profileAssumptions('truck').join(' ')).toMatch(/legal truck access is NOT verified/);
  });
});

describe('graph rules on hand-checkable networks', () => {
  it('obeys one-way streets for vehicles; walking ignores them', () => {
    const city = onewayCity();
    const car = new RoutingEngine(city, 'car');
    const fwd = car.query('dijkstra', { origin: 0, destination: 1, objective: 'distance' }).result;
    expect(fwd.distanceM).toBeCloseTo(100, 6);
    const back = car.query('dijkstra', { origin: 1, destination: 0, objective: 'distance' }).result;
    expect(back.segments).toEqual([1]);
    expect(back.distanceM).toBeCloseTo(2 * Math.hypot(50, 80), 6);
    const walk = new RoutingEngine(city, 'foot').query('dijkstra', { origin: 1, destination: 0, objective: 'distance' }).result;
    expect(walk.segments).toEqual([0]);
    expect(walk.distanceM).toBeCloseTo(100, 6);
  });
  it('a "no" restriction forbids exactly that turn', () => {
    const free = new RoutingEngine(tJunction(), 'car').query('dijkstra', { origin: 0, destination: 3, objective: 'distance' }).result;
    expect(free.distanceM).toBeCloseTo(200, 6);
    const banned = new RoutingEngine(tJunction([{ kind: 'no', fromSeg: 0, via: 1, toSeg: 2 }]), 'car');
    const r = banned.query('dijkstra', { origin: 0, destination: 3, objective: 'distance' }).result;
    expect(r.segments).toEqual([0, 1, 3]);
    expect(r.distanceM).toBeCloseTo(200 + Math.hypot(100, 100), 6);
    // Walking ignores turn restrictions; bicycles obey them unless exempted.
    expect(new RoutingEngine(tJunction([{ kind: 'no', fromSeg: 0, via: 1, toSeg: 2 }]), 'foot').query('dijkstra', { origin: 0, destination: 3, objective: 'distance' }).result.distanceM).toBeCloseTo(200, 6);
    expect(new RoutingEngine(tJunction([{ kind: 'no', fromSeg: 0, via: 1, toSeg: 2, except: 'bicycle' }]), 'bicycle').query('dijkstra', { origin: 0, destination: 3, objective: 'distance' }).result.distanceM).toBeCloseTo(200, 6);
  });
  it('an "only" restriction forbids every other continuation', () => {
    const e = new RoutingEngine(tJunction([{ kind: 'only', fromSeg: 0, via: 1, toSeg: 1 }]), 'car');
    const r = e.query('dijkstra', { origin: 0, destination: 3, objective: 'distance' }).result;
    expect(r.segments).toEqual([0, 1, 3]);
    const g = e.graph;
    expect(transitionIndex(g, 0, 2 * 2)).toBe(-1); // s0 forward → s2 forward: banned
    expect(transitionIndex(g, 0, 2 * 1)).toBeGreaterThanOrEqual(0); // straight on: allowed
  });
  it('closed segments are avoided and can make a destination unreachable', () => {
    const city = tJunction();
    const r = new RoutingEngine(city, 'car', { closedSegments: [2] }).query('dijkstra', { origin: 0, destination: 3, objective: 'distance' }).result;
    expect(r.segments).toEqual([0, 1, 3]);
    const none = new RoutingEngine(city, 'car', { closedSegments: [2, 3] }).query('dijkstra', { origin: 0, destination: 3, objective: 'distance' }).result;
    expect(none.found).toBe(false);
    expect(none.cost).toBe(Infinity);
  });
  it('one-way overrides change permitted directions for vehicles', () => {
    const city = tJunction();
    const e = new RoutingEngine(city, 'car', { onewayOverrides: new Map([[2, 'reverse' as const]]) });
    const r = e.query('dijkstra', { origin: 0, destination: 3, objective: 'distance' }).result;
    expect(r.segments).toEqual([0, 1, 3]);
    const walk = new RoutingEngine(city, 'foot', { onewayOverrides: new Map([[2, 'reverse' as const]]) }).query('dijkstra', { origin: 0, destination: 3, objective: 'distance' }).result;
    expect(walk.segments).toEqual([0, 2]);
  });
  it('U-turns only at dead ends for vehicles, with the stated penalty', () => {
    // 0 —s0— 1 —s1— 2 (dead end), and 1 —s2— 3; turning from s0 into s2 at node 1 is forbidden.
    const city = syntheticCity({
      nodes: [
        [0, 0],
        [100, 0],
        [200, 0],
        [100, 100],
      ],
      segments: [
        { u: 0, v: 1 },
        { u: 1, v: 2 },
        { u: 1, v: 3 },
      ],
      restrictions: [{ kind: 'no', fromSeg: 0, via: 1, toSeg: 2 }],
    });
    const e = new RoutingEngine(city, 'car');
    const g = e.graph;
    expect(transitionIndex(g, 0, 1)).toBe(-1); // U-turn at junction 1: not allowed
    const k = transitionIndex(g, 2, 3); // U-turn at dead end 2
    expect(k).toBeGreaterThanOrEqual(0);
    expect(g.outPen[k]).toBe(20);
    const d = e.query('dijkstra', { origin: 0, destination: 3, objective: 'distance' }).result;
    expect(d.arcs).toEqual([0, 2, 3, 4]);
    expect(d.distanceM).toBeCloseTo(400, 6);
    expect(d.turns.uturn).toBe(1);
    const t = e.query('dijkstra', { origin: 0, destination: 3, objective: 'time' }).result;
    // 400 m at 20 km/h + straight (0) + U-turn (20) + left turn (4).
    expect(t.timeS).toBeCloseTo(400 / (20 / 3.6) + 0 + 20 + 4, 6);
    expect(validateRoute(city, g, { origin: 0, destination: 3, objective: 'time' }, t).ok).toBe(true);
    // Walking may turn back anywhere with no penalty.
    const wg = buildRoutingGraph(city, 'foot');
    expect(transitionIndex(wg, 0, 1)).toBeGreaterThanOrEqual(0);
  });
  it('access tags follow the hierarchy; truck limits apply only where tagged', () => {
    const city = syntheticCity({
      nodes: [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      segments: [
        { u: 0, v: 1, tags: { access: 'no', foot: 'yes' } },
        { u: 0, v: 2, tags: { maxweight: '10' } },
        { u: 2, v: 1 },
      ],
    });
    const car = new RoutingEngine(city, 'car').query('dijkstra', { origin: 0, destination: 1, objective: 'distance' }).result;
    expect(car.segments).toEqual([1, 2]);
    const foot = new RoutingEngine(city, 'foot').query('dijkstra', { origin: 0, destination: 1, objective: 'distance' }).result;
    expect(foot.segments).toEqual([0]);
    const truck = new RoutingEngine(city, 'truck').query('dijkstra', { origin: 0, destination: 1, objective: 'distance' }).result;
    expect(truck.found).toBe(false); // access=no on s0, maxweight 10 t < 12 t on s1
    const light = new RoutingEngine(city, 'truck', { vehicle: { weightT: 7.5, heightM: 3 } }).query('dijkstra', { origin: 0, destination: 1, objective: 'distance' }).result;
    expect(light.segments).toEqual([1, 2]);
  });
  it('the validator rejects tampered routes', () => {
    const city = tJunction([{ kind: 'no', fromSeg: 0, via: 1, toSeg: 2 }]);
    const e = new RoutingEngine(city, 'car');
    const q = { origin: 0, destination: 3, objective: 'distance' as const };
    const good = e.query('dijkstra', q).result;
    expect(validateRoute(city, e.graph, q, good).ok).toBe(true);
    const forbiddenTurn = { ...good, arcs: [0, 4], segments: [0, 2], distanceM: 200, cost: 200 };
    const v1 = validateRoute(city, e.graph, q, forbiddenTurn);
    expect(v1.ok).toBe(false);
    expect(v1.checks.find((c) => c.id === 'turns')!.passed).toBe(false);
    const wrongCost = { ...good, cost: good.cost - 1 };
    expect(validateRoute(city, e.graph, q, wrongCost).checks.find((c) => c.id === 'cost')!.passed).toBe(false);
    const broken = { ...good, arcs: [0, 6] };
    expect(validateRoute(city, e.graph, q, broken).checks.find((c) => c.id === 'continuity')!.passed).toBe(false);
  });
});

describe('algorithm equivalence on random synthetic grids', () => {
  it('every algorithm returns the reference optimum (Bellman–Ford) on ≥ 300 queries per objective, and every route validates', () => {
    let queries = 0;
    let found = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const city = randomGridCity(seed);
      for (const profile of PROFILES) {
        const e = new RoutingEngine(city, profile);
        const r = rng(seed * 31 + profile.length);
        for (const objective of OBJECTIVES) {
          for (let i = 0; i < 4; i++) {
            const o = Math.floor(r() * city.nodeCount);
            const d = Math.floor(r() * city.nodeCount);
            const q = { origin: o, destination: d, objective };
            const ref = referenceCost(e.graph, o, d, objective);
            queries++;
            if (Number.isFinite(ref)) found++;
            for (const a of ALGOS) {
              const res = e.query(a, q).result;
              expect(res.found, `${a} found ${profile} ${objective} seed ${seed}`).toBe(Number.isFinite(ref));
              if (!res.found) continue;
              expect(rel(res.cost, ref), `${a} cost ${profile} ${objective} seed ${seed}`).toBeLessThan(1e-9);
              const v = validateRoute(city, e.graph, q, res);
              expect(v.ok, `${a} validation ${JSON.stringify(v.checks.filter((c) => !c.passed))}`).toBe(true);
            }
          }
        }
      }
    }
    expect(queries).toBeGreaterThanOrEqual(600);
    expect(found).toBeGreaterThan(queries / 3);
  });
  it('is deterministic: same graph, same answers, same traces', () => {
    const city = randomGridCity(99);
    const a = new RoutingEngine(city, 'car');
    const b = new RoutingEngine(city, 'car');
    expect(Array.from(a.graph.outTo)).toEqual(Array.from(b.graph.outTo));
    for (const alg of ALGOS) {
      const q = { origin: 0, destination: city.nodeCount - 1, objective: 'time' as const };
      const x = a.query(alg, q, { trace: true });
      const y = b.query(alg, q, { trace: true });
      expect(x.result.arcs).toEqual(y.result.arcs);
      expect(x.result.cost).toBe(y.result.cost);
      expect(Array.from(x.trace!.arcs)).toEqual(Array.from(y.trace!.arcs));
    }
  });
  it('traces record the real settle order and are consistent with the result', () => {
    const city = randomGridCity(5);
    const e = new RoutingEngine(city, 'car');
    const q = { origin: 0, destination: city.nodeCount - 1, objective: 'distance' as const };
    const d = e.query('dijkstra', q, { trace: true });
    if (!d.result.found) return;
    const t = d.trace!;
    expect(t.count).toBe(d.result.expanded);
    for (let i = 1; i < t.count; i++) expect(t.cost[i]!).toBeGreaterThanOrEqual(t.cost[i - 1]! - 1e-9); // Dijkstra settles in cost order
    expect(t.arcs[t.count - 1]).toBe(d.result.arcs[d.result.arcs.length - 1]);
    const astar = e.query('astar', q, { trace: true });
    expect(astar.trace!.count).toBeLessThanOrEqual(t.count + 1);
    const bi = e.query('bidirectional', q, { trace: true });
    expect(new Set(Array.from(bi.trace!.side))).toEqual(new Set([0, 1]));
  });
});

describe('reachability', () => {
  it('is monotone in the threshold and matches Dijkstra travel times', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const city = randomGridCity(seed, 8, 7);
      const e = new RoutingEngine(city, 'car');
      const origin = Math.floor(rng(seed)() * city.nodeCount);
      const r = reachability(e.graph, origin, [20, 40, 60]);
      for (let i = 1; i < r.levels.length; i++) {
        const small = new Set(Array.from(r.levels[i - 1]!.fullArcs));
        const big = new Set(Array.from(r.levels[i]!.fullArcs));
        for (const a of small) expect(big.has(a)).toBe(true);
        expect(r.levels[i]!.nodes).toBeGreaterThanOrEqual(r.levels[i - 1]!.nodes);
        expect(r.levels[i]!.lengthM).toBeGreaterThanOrEqual(r.levels[i - 1]!.lengthM - 1e-9);
      }
      for (let t = 0; t < city.nodeCount; t++) {
        const arr = r.nodeArrivalS[t]!;
        if (!Number.isFinite(arr) || t === origin) continue;
        const d = e.query('dijkstra', { origin, destination: t, objective: 'time' }).result;
        expect(rel(arr, d.cost)).toBeLessThan(1e-9);
      }
      for (const lv of r.levels) {
        for (let i = 0; i < lv.partialArcs.length; i++) {
          const a = lv.partialArcs[i]!;
          expect(r.entryS[a]!).toBeLessThan(lv.thresholdS);
          expect(r.exitS[a]!).toBeGreaterThan(lv.thresholdS);
          expect(lv.partialFraction[i]!).toBeGreaterThanOrEqual(0);
          expect(lv.partialFraction[i]!).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
