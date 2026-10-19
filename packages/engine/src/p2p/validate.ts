import type { CityModel } from '../city/types.js';
import { accessFor, classifyTurn, onewayApplies, restrictionApplies, speedFor, truckLimitsAllow } from './profiles.js';
import { arcDirections, type RoutingGraph } from './network.js';
import type { RouteQuery, RouteResult } from './search.js';

/**
 * Independent route validation. Re-derives every rule from the city data and
 * the profile — not from the routing graph's precomputed arrays or the
 * algorithm that produced the route — and checks the route against them:
 * endpoints, continuity, permission of every arc (access, one-way, closures),
 * turn restrictions and the U-turn rule, and the reported distance, time and
 * cost.
 */
export interface ValidationCheck {
  id: 'endpoints' | 'continuity' | 'permitted' | 'turns' | 'distance' | 'time' | 'cost';
  passed: boolean;
  detail: string;
}

const tailOf = (c: CityModel, a: number): number => ((a & 1) === 0 ? c.segU[a >> 1]! : c.segV[a >> 1]!);
const headOf = (c: CityModel, a: number): number => ((a & 1) === 0 ? c.segV[a >> 1]! : c.segU[a >> 1]!);
const close = (x: number, y: number): boolean => Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x), Math.abs(y));

/** Whether arc a is permitted for the graph's profile and scenario, derived from scratch. */
export function arcPermitted(city: CityModel, g: RoutingGraph, a: number): { ok: boolean; reason?: string } {
  const s = a >> 1;
  if (s < 0 || s >= city.segCount) return { ok: false, reason: 'no such segment' };
  if (g.closed[s]) return { ok: false, reason: 'segment closed' };
  const way = city.ways[city.segWay[s]!]!;
  const acc = accessFor(way, g.spec);
  if (!acc.allowed) return { ok: false, reason: acc.reason };
  if (g.profile === 'truck') {
    const lim = truckLimitsAllow(way, g.vehicle);
    if (!lim.allowed) return { ok: false, reason: lim.reason ?? 'truck limit' };
  }
  const dir = g.direction[s]!;
  const overridden = dir !== (city.segOneway[s] ? 1 : 0);
  const binds = g.spec.obeysOneway && (overridden || onewayApplies(way, g.spec));
  if (binds && dir === 1 && (a & 1) === 1) return { ok: false, reason: 'against one-way direction' };
  if (binds && dir === 2 && (a & 1) === 0) return { ok: false, reason: 'against one-way direction' };
  return { ok: true };
}

/** Turn from arc a into arc b at their shared node: permitted? penalty (s)? */
export function turnRule(city: CityModel, g: RoutingGraph, a: number, b: number): { ok: boolean; penalty: number; reason?: string } {
  const via = headOf(city, a);
  for (const r of city.restrictions) {
    if (r.via !== via || !restrictionApplies(r.except, g.spec)) continue;
    const fromArc = city.segV[r.fromSeg] === via ? 2 * r.fromSeg : city.segU[r.fromSeg] === via ? 2 * r.fromSeg + 1 : -1;
    const toArc = city.segU[r.toSeg] === via ? 2 * r.toSeg : city.segV[r.toSeg] === via ? 2 * r.toSeg + 1 : -1;
    if (fromArc !== a) continue;
    if (r.kind === 'no' && toArc === b) return { ok: false, penalty: 0, reason: `restriction ${r.value} (relation ${r.osmId})` };
    if (r.kind === 'only' && toArc !== b) {
      // Several "only" restrictions from the same arc are combined (any of their targets is allowed).
      const allowedTargets = city.restrictions
        .filter((x) => x.kind === 'only' && x.via === via && restrictionApplies(x.except, g.spec))
        .filter((x) => (city.segV[x.fromSeg] === via ? 2 * x.fromSeg : city.segU[x.fromSeg] === via ? 2 * x.fromSeg + 1 : -1) === a)
        .map((x) => (city.segU[x.toSeg] === via ? 2 * x.toSeg : city.segV[x.toSeg] === via ? 2 * x.toSeg + 1 : -1));
      if (!allowedTargets.includes(b)) return { ok: false, penalty: 0, reason: `restriction ${r.value} (relation ${r.osmId})` };
    }
  }
  const turns = g.spec.turns;
  if ((a ^ 1) === b) {
    if (g.spec.uturnOnlyAtDeadEnds) {
      // Is any other arc leaving `via` permitted?
      for (let s = 0; s < city.segCount; s++) {
        for (const c of [2 * s, 2 * s + 1]) {
          if (c === b || tailOf(city, c) !== via) continue;
          if (arcPermitted(city, g, c).ok) return { ok: false, penalty: 0, reason: 'U-turn where another continuation exists' };
        }
      }
    }
    return { ok: true, penalty: turns ? turns.uturn : 0 };
  }
  const din = arcDirections(city, a).in;
  const dout = arcDirections(city, b).out;
  const kind = classifyTurn(din[0], din[1], dout[0], dout[1]);
  return { ok: true, penalty: turns ? turns[kind] : 0 };
}

export function validateRoute(city: CityModel, g: RoutingGraph, q: RouteQuery, r: RouteResult): { ok: boolean; checks: ValidationCheck[] } {
  const checks: ValidationCheck[] = [];
  const add = (id: ValidationCheck['id'], passed: boolean, detail: string): void => {
    checks.push({ id, passed, detail });
  };
  if (!r.found) {
    add('endpoints', r.arcs.length === 0, 'No route reported; no arcs returned.');
    return { ok: checks.every((c) => c.passed), checks };
  }
  const arcs = r.arcs;
  if (q.origin === q.destination) {
    add('endpoints', arcs.length === 0 && r.cost === 0, 'Origin equals destination: empty route of cost 0.');
    return { ok: checks.every((c) => c.passed), checks };
  }
  add('endpoints', arcs.length > 0 && tailOf(city, arcs[0]!) === q.origin && headOf(city, arcs[arcs.length - 1]!) === q.destination, `Route starts at node ${q.origin} and ends at node ${q.destination}.`);
  let cont = true;
  for (let i = 1; i < arcs.length; i++) if (headOf(city, arcs[i - 1]!) !== tailOf(city, arcs[i]!)) cont = false;
  add('continuity', cont, `${arcs.length} consecutive arcs share their intersections.`);
  let permitted = true;
  let why = '';
  for (const a of arcs) {
    const p = arcPermitted(city, g, a);
    if (!p.ok) {
      permitted = false;
      why = `arc ${a}: ${p.reason}`;
      break;
    }
  }
  add('permitted', permitted, permitted ? 'Every arc is open and permitted for this profile and direction.' : why);
  let turnsOk = true;
  let turnWhy = '';
  let penalties = 0;
  for (let i = 1; i < arcs.length; i++) {
    const t = turnRule(city, g, arcs[i - 1]!, arcs[i]!);
    if (!t.ok) {
      turnsOk = false;
      turnWhy = `between arcs ${arcs[i - 1]} and ${arcs[i]}: ${t.reason}`;
    }
    penalties += t.penalty;
  }
  add('turns', turnsOk, turnsOk ? 'No forbidden turn or U-turn.' : turnWhy);
  let dist = 0;
  let time = 0;
  for (const a of arcs) {
    const s = a >> 1;
    dist += city.segLen[s]!;
    const sp = speedFor(city.ways[city.segWay[s]!]!, g.spec);
    time += city.segLen[s]! / (sp.kmh / 3.6);
  }
  time += penalties;
  add('distance', close(dist, r.distanceM), `Recomputed ${dist.toFixed(3)} m; reported ${r.distanceM.toFixed(3)} m.`);
  add('time', close(time, r.timeS), `Recomputed ${time.toFixed(3)} s; reported ${r.timeS.toFixed(3)} s.`);
  const expected = q.objective === 'time' ? time : dist;
  add('cost', close(expected, r.cost), `Objective (${q.objective}) recomputed ${expected.toFixed(6)}; reported ${r.cost.toFixed(6)}.`);
  return { ok: checks.every((c) => c.passed), checks };
}
