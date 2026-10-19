import type { CityModel } from '../city/types.js';
import { accessFor, classifyTurn, onewayApplies, PROFILE_SPECS, restrictionApplies, speedFor, truckLimitsAllow, DEFAULT_TRUCK, type Objective, type ProfileId, type ProfileSpec, type TruckVehicle } from './profiles.js';

/**
 * Edge-based (turn-expanded) routing graph for one travel profile.
 *
 * Graph NODES are directed ARCS over physical road segments: arc 2s travels
 * segment s from segU to segV, arc 2s+1 from segV to segU. Graph EDGES are
 * TRANSITIONS a → b between an arc arriving at a city node and an arc leaving
 * it, carrying the turn penalty. Representing turns explicitly is what lets
 * turn restrictions and turn costs be honoured exactly by every algorithm.
 *
 * Cost of a route = sum over its arcs of the arc cost + sum over its
 * transitions of the transition cost, where for
 *   objective 'time':     arc cost = length / speed (s), transition = turn penalty (s);
 *   objective 'distance': arc cost = length (m),         transition = 0.
 * Every algorithm runs on this same graph with the same cost function.
 */

export type OnewayOverride = 'forward' | 'reverse' | 'two-way';

export interface RoutingGraphOptions {
  /** Segments treated as closed for every profile (scenario road closures). */
  closedSegments?: Iterable<number>;
  /** Scenario changes of travel direction per segment (forward = segU → segV only). */
  onewayOverrides?: ReadonlyMap<number, OnewayOverride>;
  /** Truck dimensions compared with maxweight / maxheight tags. */
  vehicle?: TruckVehicle;
}

export const TURN_CODES = ['straight', 'left', 'right', 'uturn'] as const;

export interface RoutingGraph {
  city: CityModel;
  profile: ProfileId;
  spec: ProfileSpec;
  vehicle: TruckVehicle;
  closed: Uint8Array;
  /** Effective direction per segment after overrides: 0 two-way, 1 forward only, 2 reverse only. */
  direction: Uint8Array;
  arcCount: number;
  arcAllowed: Uint8Array;
  arcTail: Int32Array;
  arcHead: Int32Array;
  arcLen: Float64Array;
  arcTime: Float64Array;
  arcSpeedKmh: Float32Array;
  /** 1 when the speed came from an OSM maxspeed tag. */
  arcSpeedFromTag: Uint8Array;
  /** 1 when access is limited to destination/delivery/customers. */
  arcDestinationOnly: Uint8Array;
  /** Forward CSR of transitions. */
  outOff: Int32Array;
  outTo: Int32Array;
  outPen: Float64Array;
  outTurn: Uint8Array;
  /** Reverse CSR of the same transitions (inFrom[i] → this arc). */
  inOff: Int32Array;
  inFrom: Int32Array;
  inPen: Float64Array;
  /** Allowed arcs leaving / entering each city node. */
  nodeOutOff: Int32Array;
  nodeOutArcs: Int32Array;
  nodeInOff: Int32Array;
  nodeInArcs: Int32Array;
  /** Highest arc speed in m/s (A* time heuristic). */
  maxSpeedMs: number;
  stats: {
    allowedArcs: number;
    transitions: number;
    deniedArcs: Record<string, number>;
    closedSegments: number;
    overriddenSegments: number;
    restrictionsApplied: number;
    restrictionsNotApplicable: number;
    bannedByRestriction: number;
    uturnsAllowed: number;
    uturnsBanned: number;
    destinationOnlyArcs: number;
    speedFromMaxspeedArcs: number;
  };
  /** Lazily built per-objective weights. */
  weightCache: Partial<Record<Objective, Weights>>;
}

export interface Weights {
  objective: Objective;
  /** Cost of travelling the arc itself. */
  arcCost: Float64Array;
  /** Folded forward edge weights: turn cost + cost of the target arc (aligned with outTo). */
  outW: Float64Array;
  /** Folded reverse edge weights: turn cost + cost of this arc (aligned with inFrom). */
  inW: Float64Array;
}

const arcSeg = (a: number): number => a >> 1;
export const reverseArc = (a: number): number => a ^ 1;

/** Direction (dx, dy) of the arc where it LEAVES its tail, and where it ARRIVES at its head. */
export function arcDirections(city: CityModel, a: number): { out: [number, number]; in: [number, number] } {
  const s = a >> 1;
  const fwd = (a & 1) === 0;
  const o = city.segPtOff[s]!;
  const e = city.segPtOff[s + 1]! - 1;
  const X = (i: number): number => city.segXY[2 * i]!;
  const Y = (i: number): number => city.segXY[2 * i + 1]!;
  const firstDir = (from: number, step: number, end: number): [number, number] => {
    for (let i = from + step; step > 0 ? i <= end : i >= end; i += step) {
      const dx = X(i) - X(from);
      const dy = Y(i) - Y(from);
      if (dx !== 0 || dy !== 0) return [dx, dy];
    }
    return [0, 0];
  };
  if (fwd) {
    const out = firstDir(o, 1, e);
    const back = firstDir(e, -1, o); // from head looking back
    return { out, in: [-back[0], -back[1]] };
  }
  const out = firstDir(e, -1, o);
  const back = firstDir(o, 1, e);
  return { out, in: [-back[0], -back[1]] };
}

export function buildRoutingGraph(city: CityModel, profile: ProfileId, opts: RoutingGraphOptions = {}): RoutingGraph {
  const spec = PROFILE_SPECS[profile];
  const vehicle = opts.vehicle ?? DEFAULT_TRUCK;
  const S = city.segCount;
  const A = 2 * S;
  const closed = new Uint8Array(S);
  let closedCount = 0;
  for (const s of opts.closedSegments ?? []) {
    if (s >= 0 && s < S && !closed[s]) {
      closed[s] = 1;
      closedCount++;
    }
  }
  const direction = new Uint8Array(S);
  let overridden = 0;
  for (let s = 0; s < S; s++) {
    const ov = opts.onewayOverrides?.get(s);
    if (ov) {
      overridden++;
      direction[s] = ov === 'forward' ? 1 : ov === 'reverse' ? 2 : 0;
    } else direction[s] = city.segOneway[s] ? 1 : 0;
  }
  const arcAllowed = new Uint8Array(A);
  const arcTail = new Int32Array(A);
  const arcHead = new Int32Array(A);
  const arcLen = new Float64Array(A);
  const arcTime = new Float64Array(A);
  const arcSpeedKmh = new Float32Array(A);
  const arcSpeedFromTag = new Uint8Array(A);
  const arcDest = new Uint8Array(A);
  const denied: Record<string, number> = {};
  const deny = (why: string, n: number): void => {
    denied[why] = (denied[why] ?? 0) + n;
  };
  let maxSpeedMs = 0;
  let destCount = 0;
  let tagSpeedCount = 0;
  for (let s = 0; s < S; s++) {
    const u = city.segU[s]!;
    const v = city.segV[s]!;
    arcTail[2 * s] = u;
    arcHead[2 * s] = v;
    arcTail[2 * s + 1] = v;
    arcHead[2 * s + 1] = u;
    arcLen[2 * s] = arcLen[2 * s + 1] = city.segLen[s]!;
    const way = city.ways[city.segWay[s]!]!;
    if (closed[s]) {
      deny('closed (scenario)', 2);
      continue;
    }
    const acc = accessFor(way, spec);
    if (!acc.allowed) {
      deny(acc.reason.startsWith('highway=') ? 'road class not used by profile' : `access ${acc.reason}`, 2);
      continue;
    }
    if (profile === 'truck') {
      const lim = truckLimitsAllow(way, vehicle);
      if (!lim.allowed) {
        deny(`truck limit (${lim.reason})`, 2);
        continue;
      }
    }
    const sp = speedFor(way, spec);
    const ms = sp.kmh / 3.6;
    let fwdOk = true;
    let revOk = true;
    const dir = direction[s]!;
    const mappedExemptBike = !opts.onewayOverrides?.has(s) && !onewayApplies(way, spec);
    if (dir !== 0 && spec.obeysOneway && !mappedExemptBike) {
      if (dir === 1) revOk = false;
      else fwdOk = false;
      deny('one-way (against direction)', 1);
    }
    for (const [a, ok] of [
      [2 * s, fwdOk],
      [2 * s + 1, revOk],
    ] as const) {
      if (!ok) continue;
      arcAllowed[a] = 1;
      arcSpeedKmh[a] = sp.kmh;
      arcTime[a] = ms > 0 ? city.segLen[s]! / ms : Infinity;
      if (sp.source === 'maxspeed') {
        arcSpeedFromTag[a] = 1;
        tagSpeedCount++;
      }
      if (acc.destinationOnly) {
        arcDest[a] = 1;
        destCount++;
      }
      if (ms > maxSpeedMs) maxSpeedMs = ms;
    }
  }

  // Allowed arcs per city node.
  const N = city.nodeCount;
  const nodeOutOff = new Int32Array(N + 1);
  const nodeInOff = new Int32Array(N + 1);
  for (let a = 0; a < A; a++) {
    if (!arcAllowed[a]) continue;
    nodeOutOff[arcTail[a]! + 1]!++;
    nodeInOff[arcHead[a]! + 1]!++;
  }
  for (let i = 0; i < N; i++) {
    nodeOutOff[i + 1]! += nodeOutOff[i]!;
    nodeInOff[i + 1]! += nodeInOff[i]!;
  }
  const nodeOutArcs = new Int32Array(nodeOutOff[N]!);
  const nodeInArcs = new Int32Array(nodeInOff[N]!);
  {
    const po = nodeOutOff.slice(0, N);
    const pi = nodeInOff.slice(0, N);
    for (let a = 0; a < A; a++) {
      if (!arcAllowed[a]) continue;
      nodeOutArcs[po[arcTail[a]!]!++] = a;
      nodeInArcs[pi[arcHead[a]!]!++] = a;
    }
  }

  // Turn restrictions → banned transitions.
  const bannedPairs = new Set<number>();
  const onlyAllowed = new Map<number, Set<number>>();
  let applied = 0;
  let notApplicable = 0;
  for (const r of city.restrictions) {
    if (!restrictionApplies(r.except, spec)) {
      notApplicable++;
      continue;
    }
    const fs = r.fromSeg;
    const ts = r.toSeg;
    const fromArc = city.segV[fs] === r.via ? 2 * fs : city.segU[fs] === r.via ? 2 * fs + 1 : -1;
    const toArc = city.segU[ts] === r.via ? 2 * ts : city.segV[ts] === r.via ? 2 * ts + 1 : -1;
    if (fromArc < 0 || toArc < 0) {
      notApplicable++;
      continue;
    }
    applied++;
    if (r.kind === 'no') bannedPairs.add(fromArc * A + toArc);
    else {
      const set = onlyAllowed.get(fromArc) ?? new Set<number>();
      set.add(toArc);
      onlyAllowed.set(fromArc, set);
    }
  }

  // Transitions.
  const counts = new Int32Array(A + 1);
  const tTo: number[] = [];
  const tPen: number[] = [];
  const tTurn: number[] = [];
  let bannedByRestriction = 0;
  let uAllowed = 0;
  let uBanned = 0;
  const dirCache = new Map<number, { out: [number, number]; in: [number, number] }>();
  const dirs = (a: number): { out: [number, number]; in: [number, number] } => {
    let d = dirCache.get(a);
    if (!d) {
      d = arcDirections(city, a);
      dirCache.set(a, d);
    }
    return d;
  };
  const turns = spec.turns;
  for (let a = 0; a < A; a++) {
    if (!arcAllowed[a]) continue;
    const h = arcHead[a]!;
    const rev = reverseArc(a);
    let others = 0;
    for (let k = nodeOutOff[h]!; k < nodeOutOff[h + 1]!; k++) if (nodeOutArcs[k] !== rev) others++;
    const only = onlyAllowed.get(a);
    for (let k = nodeOutOff[h]!; k < nodeOutOff[h + 1]!; k++) {
      const b = nodeOutArcs[k]!;
      if (bannedPairs.has(a * A + b) || (only && !only.has(b))) {
        bannedByRestriction++;
        continue;
      }
      let code: number;
      let pen = 0;
      if (b === rev) {
        if (spec.uturnOnlyAtDeadEnds && others > 0) {
          uBanned++;
          continue;
        }
        uAllowed++;
        code = 3;
        pen = turns ? turns.uturn : 0;
      } else {
        const din = dirs(a).in;
        const dout = dirs(b).out;
        const kind = classifyTurn(din[0], din[1], dout[0], dout[1]);
        code = kind === 'straight' ? 0 : kind === 'left' ? 1 : 2;
        pen = turns ? turns[kind] : 0;
      }
      tTo.push(b);
      tPen.push(pen);
      tTurn.push(code);
      counts[a + 1]!++;
    }
  }
  const outOff = new Int32Array(A + 1);
  for (let a = 0; a < A; a++) outOff[a + 1] = outOff[a]! + counts[a + 1]!;
  const outTo = Int32Array.from(tTo);
  const outPen = Float64Array.from(tPen);
  const outTurn = Uint8Array.from(tTurn);
  // Reverse CSR.
  const inCount = new Int32Array(A + 1);
  for (let i = 0; i < outTo.length; i++) inCount[outTo[i]! + 1]!++;
  const inOff = new Int32Array(A + 1);
  for (let a = 0; a < A; a++) inOff[a + 1] = inOff[a]! + inCount[a + 1]!;
  const inFrom = new Int32Array(outTo.length);
  const inPen = new Float64Array(outTo.length);
  const fill = inOff.slice(0, A);
  for (let a = 0; a < A; a++) {
    for (let k = outOff[a]!; k < outOff[a + 1]!; k++) {
      const b = outTo[k]!;
      const pos = fill[b]!++;
      inFrom[pos] = a;
      inPen[pos] = outPen[k]!;
    }
  }
  let allowedArcs = 0;
  for (let a = 0; a < A; a++) allowedArcs += arcAllowed[a]!;
  return {
    city,
    profile,
    spec,
    vehicle,
    closed,
    direction,
    arcCount: A,
    arcAllowed,
    arcTail,
    arcHead,
    arcLen,
    arcTime,
    arcSpeedKmh,
    arcSpeedFromTag,
    arcDestinationOnly: arcDest,
    outOff,
    outTo,
    outPen,
    outTurn,
    inOff,
    inFrom,
    inPen,
    nodeOutOff,
    nodeOutArcs,
    nodeInOff,
    nodeInArcs,
    maxSpeedMs,
    stats: {
      allowedArcs,
      transitions: outTo.length,
      deniedArcs: denied,
      closedSegments: closedCount,
      overriddenSegments: overridden,
      restrictionsApplied: applied,
      restrictionsNotApplicable: notApplicable,
      bannedByRestriction,
      uturnsAllowed: uAllowed,
      uturnsBanned: uBanned,
      destinationOnlyArcs: destCount,
      speedFromMaxspeedArcs: tagSpeedCount,
    },
    weightCache: {},
  };
}

/** Per-objective costs, computed once per graph. */
export function weightsFor(g: RoutingGraph, objective: Objective): Weights {
  const cached = g.weightCache[objective];
  if (cached) return cached;
  const arcCost = objective === 'time' ? g.arcTime : g.arcLen;
  const outW = new Float64Array(g.outTo.length);
  for (let a = 0; a < g.arcCount; a++) {
    for (let k = g.outOff[a]!; k < g.outOff[a + 1]!; k++) outW[k] = (objective === 'time' ? g.outPen[k]! : 0) + arcCost[g.outTo[k]!]!;
  }
  const inW = new Float64Array(g.inFrom.length);
  for (let b = 0; b < g.arcCount; b++) {
    for (let k = g.inOff[b]!; k < g.inOff[b + 1]!; k++) inW[k] = (objective === 'time' ? g.inPen[k]! : 0) + arcCost[b]!;
  }
  const w: Weights = { objective, arcCost, outW, inW };
  g.weightCache[objective] = w;
  return w;
}

/** Transition index from arc a to arc b, or -1 when the turn is not permitted. */
export function transitionIndex(g: RoutingGraph, a: number, b: number): number {
  for (let k = g.outOff[a]!; k < g.outOff[a + 1]!; k++) if (g.outTo[k] === b) return k;
  return -1;
}

export { arcSeg };
