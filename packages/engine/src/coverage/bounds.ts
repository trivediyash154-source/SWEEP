import type { Graph } from '../types.js';
import { UnionFind } from '../graph.js';
import { fromScaled } from '../units.js';
import { minCostFlow, type FlowArc } from '../mincostflow.js';
import { minCostPerfectMatchingComplete } from '../matching/blossom.js';
import { arcDijkstra, buildArcGraph, treePath, type ArcGraph } from './arcs.js';


/**
 * Connectors and lower bounds for coverage of a zone.
 *
 * CONNECTORS. When the required streets of a zone fall into several groups
 * (or the depot is not on a required street), covering them optimally is the
 * Rural Postman Problem, which is NP-hard. SWEEP connects the groups with a
 * minimum spanning tree over groups, where the cost between two groups is
 * their shortest legal path, and then solves the CONNECTED problem (groups
 * plus connector paths, each driven at least once). The result is a valid
 * route; its optimality holds for the connected problem only, so the gap to a
 * lower bound of the ORIGINAL problem is reported instead of an optimality claim.
 *
 * LOWER BOUNDS (valid for the original problem, with or without connectors):
 *
 *  Undirected. Let R be the required edges and T the vertices of odd degree in
 *  R. Any closed walk that traverses every edge of R traverses each edge of a
 *  multiset R + X, and every vertex has even degree in R + X, so the odd
 *  vertices of X are exactly T. X therefore contains |T|/2 edge-disjoint paths
 *  pairing up the vertices of T, and
 *     cost(walk) ≥ c(R) + min over perfect matchings M of T of Σ_{(a,b)∈M} d(a,b)   (the T-join bound)
 *  where d is the shortest-path distance. When |T| ≤ exactMax that matching is
 *  computed exactly (blossom). Otherwise SWEEP uses a feasible dual of the
 *  fractional perfect-matching LP (see fractionalMatchingDual): numbers y_v
 *  with y_a + y_b ≤ d(a, b) for every pair, so any perfect matching costs at
 *  least Σ y_v. The start y_v = nn(v)/2 (half the distance to the nearest other
 *  odd vertex) is already feasible; coordinate ascent only increases it.
 *
 *  Directed. Let R be the required arcs and b(v) = in_R(v) − out_R(v). The
 *  extra arcs X of any closed walk covering R satisfy out_X(v) − in_X(v) = b(v),
 *  i.e. X is a feasible flow, so cost(walk) ≥ c(R) + (minimum-cost flow value).
 */

export interface Components {
  /** Component index per vertex (-1 when the vertex touches no required edge). */
  of: Int32Array;
  /** Vertex lists per component. */
  vertices: number[][];
}

export function requiredComponents(graph: Graph, ag: ArcGraph, extraVertex: number | null): Components {
  const uf = new UnionFind(ag.n);
  const touched = new Uint8Array(ag.n);
  graph.edges.forEach((e, k) => {
    if (!e.required) return;
    const a = ag.fwdArc[k]!;
    const u = ag.arcTail[a]!;
    const v = ag.arcHead[a]!;
    uf.union(u, v);
    touched[u] = 1;
    touched[v] = 1;
  });
  if (extraVertex !== null) touched[extraVertex] = 1;
  const of = new Int32Array(ag.n).fill(-1);
  const byRoot = new Map<number, number>();
  const vertices: number[][] = [];
  for (let v = 0; v < ag.n; v++) {
    if (!touched[v]) continue;
    const r = uf.find(v);
    let c = byRoot.get(r);
    if (c === undefined) {
      c = vertices.length;
      byRoot.set(r, c);
      vertices.push([]);
    }
    of[v] = c;
    vertices[c]!.push(v);
  }
  return { of, vertices };
}

export interface ConnectorPlan {
  components: number;
  /** Oriented arcs (indices into the arc graph) of the connector paths, in path order. */
  arcs: number[][];
  /** Total length of the connector paths, metres. */
  distance: number;
}

/** Minimum spanning tree over required groups (and the depot), with shortest legal paths as connectors. */
export function planConnectors(graph: Graph, ag: ArcGraph, depot: number): ConnectorPlan {
  const depotOnRequired = graph.edges.some((e, k) => e.required && (ag.arcTail[ag.fwdArc[k]!] === depot || ag.arcHead[ag.fwdArc[k]!] === depot));
  const comps = requiredComponents(graph, ag, depotOnRequired ? null : depot);
  const C = comps.vertices.length;
  if (C <= 1) return { components: C, arcs: [], distance: 0 };
  // Distances between groups: forward multi-source Dijkstra from every group.
  const trees = comps.vertices.map((vs) => arcDijkstra(ag, vs));
  const best: { d: number; target: number }[][] = trees.map((t) => {
    const row = Array.from({ length: C }, () => ({ d: Infinity, target: -1 }));
    for (let v = 0; v < ag.n; v++) {
      const c = comps.of[v]!;
      if (c < 0) continue;
      const d = t.dist[v]!;
      if (d < row[c]!.d || (d === row[c]!.d && v < row[c]!.target)) row[c] = { d, target: v };
    }
    return row;
  });
  // Prim on the symmetric cost min(d(A→B), d(B→A)).
  const inTree = new Uint8Array(C);
  const key = new Float64Array(C).fill(Infinity);
  const link = new Int32Array(C).fill(-1);
  key[0] = 0;
  const arcs: number[][] = [];
  let distance = 0;
  for (let it = 0; it < C; it++) {
    let c = -1;
    for (let x = 0; x < C; x++) if (!inTree[x] && (c < 0 || key[x]! < key[c]!)) c = x;
    if (c < 0 || !Number.isFinite(key[c]!)) throw new Error('planConnectors: required streets are in parts of the network that no street connects');
    inTree[c] = 1;
    if (link[c]! >= 0) {
      const p = link[c]!;
      const pc = best[p]![c]!;
      const cp = best[c]![p]!;
      const [from, to] = pc.d <= cp.d ? [p, c] : [c, p];
      const path = treePath(ag, trees[from]!, best[from]![to]!.target);
      arcs.push(path);
      distance += Math.min(pc.d, cp.d);
    }
    for (let x = 0; x < C; x++) {
      if (inTree[x]) continue;
      const w = Math.min(best[c]![x]!.d, best[x]![c]!.d);
      if (w < key[x]!) {
        key[x] = w;
        link[x] = c;
      }
    }
  }
  return { components: C, arcs, distance: fromScaled(distance) };
}

export interface LowerBound {
  /** Value in metres (same units as edge weights). */
  value: number;
  /** Which bound was computed. */
  method: 't-join-exact-matching' | 't-join-fractional-dual' | 'min-cost-flow-balance' | 'required-length';
  requiredLength: number;
  detail: string;
}

/** Lower bound for undirected coverage of the required edges (see the module note). */
export function undirectedLowerBound(graph: Graph, exactMax = 600): LowerBound {
  const ag = buildArcGraph(graph, false);
  const deg = new Int32Array(ag.n);
  let req = 0;
  graph.edges.forEach((e, k) => {
    if (!e.required) return;
    req += ag.arcCost[ag.fwdArc[k]!]!;
    const a = ag.fwdArc[k]!;
    deg[ag.arcTail[a]!] = deg[ag.arcTail[a]!]! + 1;
    deg[ag.arcHead[a]!] = deg[ag.arcHead[a]!]! + 1;
  });
  const T: number[] = [];
  for (let v = 0; v < ag.n; v++) if (deg[v]! % 2 === 1) T.push(v);
  const requiredLength = fromScaled(req);
  if (T.length === 0) return { value: requiredLength, method: 'required-length', requiredLength, detail: 'Every intersection has even required degree: the required length itself is attainable as a bound.' };
  const isT = new Int32Array(ag.n).fill(-1);
  T.forEach((v, i) => (isT[v] = i));
  if (T.length <= exactMax) {
    const dist = T.map((s) => arcDijkstra(ag, [s]).dist);
    const res = minCostPerfectMatchingComplete(T.length, (i, j) => dist[i]![T[j]!]!);
    return {
      value: fromScaled(req + res.total),
      method: 't-join-exact-matching',
      requiredLength,
      detail: `Required length + minimum-cost perfect matching of the ${T.length} odd-degree intersections (exact blossom${res.certificateVerified ? ', LP certificate verified' : ''}).`,
    };
  }
  const dual = fractionalMatchingDual(ag, T, 16);
  const startTxt = dual.assignment === 'used' ? 'the better of the nearest-neighbour start and the optimal candidate-assignment dual' : 'the nearest-neighbour start';
  return {
    value: fromScaled(req + dual.value),
    method: 't-join-fractional-dual',
    requiredLength,
    detail: `Required length + a feasible dual of the fractional perfect-matching LP over all pairs of the ${T.length} odd-degree intersections (exact distances to each one's ${dual.candidates} nearest; every other pair bounded below by the search radius; coordinate ascent from ${startTxt}).`,
  };
}

/** Segment tree over a fixed array supporting point updates and range min (or max) queries. */
class SegTree {
  private t: Float64Array;
  private size: number;
  constructor(
    n: number,
    private readonly identity: number,
    private readonly op: (a: number, b: number) => number,
  ) {
    this.size = 1;
    while (this.size < Math.max(1, n)) this.size <<= 1;
    this.t = new Float64Array(2 * this.size).fill(identity);
  }
  set(i: number, v: number): void {
    let p = i + this.size;
    this.t[p] = v;
    for (p >>= 1; p >= 1; p >>= 1) this.t[p] = this.op(this.t[2 * p]!, this.t[2 * p + 1]!);
  }
  query(lo: number, hi: number): number {
    let res = this.identity;
    if (lo > hi) return res;
    let l = lo + this.size;
    let r = hi + this.size + 1;
    while (l < r) {
      if (l & 1) res = this.op(res, this.t[l++]!);
      if (r & 1) res = this.op(res, this.t[--r]!);
      l >>= 1;
      r >>= 1;
    }
    return res;
  }
}

/**
 * Feasible dual of the fractional perfect-matching LP on the complete metric
 * graph over T:  maximise Σ y_v  subject to  y_a + y_b ≤ d(a, b) for all pairs.
 * For ANY perfect matching M, Σ_{(a,b)∈M} d(a,b) ≥ Σ_{(a,b)∈M} (y_a + y_b) = Σ_v y_v,
 * so Σ y_v is a valid lower bound on the minimum matching (and the T-join).
 *
 * Only distances to each vertex's K nearest odd vertices are computed (bounded
 * Dijkstra, exact). Let r_a be the distance of a's K-th nearest. If b is not
 * among a's K nearest, d(a,b) ≥ r_a (Dijkstra settles vertices in
 * non-decreasing distance); the graph is undirected, so for a pair known to
 * neither side d(a,b) ≥ max(r_a, r_b). Constraints for known pairs use the
 * exact distance; all other pairs use max(r_a, r_b), which keeps y feasible
 * for the full complete-graph LP. Start: y_v = nn(v)/2 (feasible). Coordinate
 * ascent raises each y_v to the largest feasible value; the objective never decreases.
 */
export function fractionalMatchingDual(
  ag: ArcGraph,
  T: readonly number[],
  K: number,
  sweeps = 6,
  opts: { assignment?: boolean; pricingRounds?: number; timings?: Record<string, number> } = {},
): { value: number; start: number; candidates: number; sweeps: number; y: Float64Array; assignment: 'used' | 'infeasible' | 'skipped' } {
  const k = T.length;
  const idx = new Int32Array(ag.n).fill(-1);
  T.forEach((v, i) => (idx[v] = i));
  const known: Map<number, number>[] = Array.from({ length: k }, () => new Map());
  const r = new Float64Array(k).fill(Infinity);
  const want = Math.min(K, k - 1);
  for (let i = 0; i < k; i++) {
    let found = 0;
    arcDijkstra(ag, [T[i]!], {
      stop: (v, d) => {
        const j = idx[v]!;
        if (j >= 0 && j !== i) {
          known[i]!.set(j, d);
          known[j]!.set(i, Math.min(d, known[j]!.get(i) ?? Infinity));
          found++;
          if (found >= want) {
            r[i] = d;
            return true;
          }
        }
        return false;
      },
    });
    if (found < want) throw new Error('fractionalMatchingDual: odd vertices in different network parts');
  }
  if (want === k - 1) r.fill(Infinity); // every pair is known exactly
  const order = Array.from({ length: k }, (_, i) => i).sort((a, b) => r[a]! - r[b]! || a - b);
  const pos = new Int32Array(k);
  order.forEach((v, p) => (pos[v] = p));
  const sortedR = order.map((v) => r[v]!);
  const firstAtLeast = (x: number): number => {
    let lo = 0;
    let hi = k;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedR[mid]! >= x) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };

  /** Largest value y_i may take given every other y (all-pairs feasibility). */
  const run = (y: Float64Array, mode: 'clip' | 'ascend', maxSweeps: number): number => {
    const minRY = new SegTree(k, Infinity, Math.min); // r_j − y_j
    const maxY = new SegTree(k, -Infinity, Math.max); // y_j
    for (let j = 0; j < k; j++) {
      minRY.set(pos[j]!, r[j]! - y[j]!);
      maxY.set(pos[j]!, y[j]!);
    }
    let done = 0;
    for (let sweep = 0; sweep < maxSweeps; sweep++) {
      let changed = 0;
      for (let i = 0; i < k; i++) {
        let bound = Infinity;
        for (const [j, d] of known[i]!) bound = Math.min(bound, d - y[j]!);
        if (Number.isFinite(r[i]!)) {
          minRY.set(pos[i]!, Infinity);
          maxY.set(pos[i]!, -Infinity);
          const p = firstAtLeast(r[i]!);
          bound = Math.min(bound, minRY.query(p, k - 1), r[i]! - maxY.query(0, p - 1));
        }
        const nv = mode === 'clip' ? Math.min(y[i]!, bound) : Math.max(y[i]!, bound);
        changed += Math.abs(nv - y[i]!);
        y[i] = nv;
        minRY.set(pos[i]!, r[i]! - y[i]!);
        maxY.set(pos[i]!, y[i]!);
      }
      done++;
      if (changed <= 0) break;
    }
    return done;
  };
  const total = (y: Float64Array): number => {
    let v = 0;
    for (let i = 0; i < k; i++) v += y[i]!;
    return v;
  };

  // Start A: y_v = nn(v)/2 (feasible), then ascent.
  const yA = new Float64Array(k);
  for (let i = 0; i < k; i++) {
    let nn = Infinity;
    for (const d of known[i]!.values()) if (d < nn) nn = d;
    yA[i] = nn / 2;
  }
  const start = total(yA);
  let used = run(yA, 'ascend', sweeps);
  let best: Float64Array = yA;
  // Start B: optimal assignment dual (bipartite double cover) with pricing.
  // y_i = (u_i + v_i)/2 is feasible for every KNOWN pair (u_i + v_j ≤ d_ij and u_j + v_i ≤ d_ij).
  // Pricing: from every vertex search up to radius y_i + max_j y_j; any odd vertex j found with
  // d(i,j) < y_i + y_j is a violated pair: add its exact distance and re-solve. Pairs not found
  // satisfy d(i,j) > y_i + max y ≥ y_i + y_j. When no violation remains, y is feasible for all
  // pairs (it is then an optimal dual of the fractional matching LP).
  let assignment: 'used' | 'infeasible' | 'skipped' = 'skipped';
  if (opts.assignment !== false && k > 1) {
    const supply = new Float64Array(2 * k);
    for (let i = 0; i < k; i++) {
      supply[i] = 1;
      supply[k + i] = -1;
    }
    const radius = new Float64Array(k);
    let yB: Float64Array | null = null;
    let feasibleAllPairs = false;
    const tm = opts.timings;
    for (let round = 0; round < (opts.pricingRounds ?? 1) && !feasibleAllPairs; round++) {
      const tf = performance.now();
      const arcs: FlowArc[] = [];
      for (let i = 0; i < k; i++) for (const [j, d] of known[i]!) arcs.push({ tail: i, head: k + j, cost: d });
      const flow = minCostFlow(2 * k, arcs, supply);
      if (tm) tm[`flow${round}`] = performance.now() - tf;
      if (!flow.feasible) {
        assignment = 'infeasible';
        yB = null;
        break;
      }
      yB = new Float64Array(k);
      for (let i = 0; i < k; i++) yB[i] = (-flow.potential[i]! + flow.potential[k + i]!) / 2;
      let ymax = -Infinity;
      for (let i = 0; i < k; i++) if (yB[i]! > ymax) ymax = yB[i]!;
      let violations = 0;
      for (let i = 0; i < k; i++) {
        const R = yB[i]! + ymax;
        radius[i] = Math.max(radius[i]!, R);
        arcDijkstra(ag, [T[i]!], {
          stop: (v, d) => {
            if (d > R) return true;
            const j = idx[v]!;
            if (j >= 0 && j !== i && !known[i]!.has(j)) {
              known[i]!.set(j, d);
              known[j]!.set(i, d);
              if (d < yB![i]! + yB![j]!) violations++;
            }
            return false;
          },
        });
      }
      feasibleAllPairs = violations === 0;
      if (tm) {
        tm[`price${round}`] = performance.now() - tf - (tm[`flow${round}`] ?? 0);
        tm[`violations${round}`] = violations;
      }
    }
    if (yB) {
      assignment = 'used';
      // Unknown pairs are now at least max(r_i, radius_i) apart; clip any residual infeasibility, then ascend.
      for (let i = 0; i < k; i++) if (Number.isFinite(r[i]!)) r[i] = Math.max(r[i]!, radius[i]!);
      order.sort((a, b) => r[a]! - r[b]! || a - b);
      order.forEach((v, p) => (pos[v] = p));
      for (let p = 0; p < k; p++) sortedR[p] = r[order[p]!]!;
      run(yB, 'clip', 1);
      const sw = run(yB, 'ascend', sweeps);
      if (total(yB) > total(best)) {
        best = yB;
        used = sw;
      }
    }
  }
  return { value: total(best), start, candidates: want, sweeps: used, y: best, assignment };
}

/** Lower bound for directed coverage with service of both directions of two-way required streets. */
export function directedLowerBound(graph: Graph): LowerBound | null {
  const ag = buildArcGraph(graph, true);
  const b = new Float64Array(ag.n);
  let req = 0;
  graph.edges.forEach((e, k) => {
    if (!e.required) return;
    for (const a of [ag.fwdArc[k]!, ag.backArc[k]!]) {
      if (a < 0) continue;
      req += ag.arcCost[a]!;
      b[ag.arcHead[a]!] = b[ag.arcHead[a]!]! + 1;
      b[ag.arcTail[a]!] = b[ag.arcTail[a]!]! - 1;
    }
  });
  const arcs: FlowArc[] = [];
  for (let a = 0; a < ag.arcTail.length; a++) arcs.push({ tail: ag.arcTail[a]!, head: ag.arcHead[a]!, cost: ag.arcCost[a]! });
  const flow = minCostFlow(ag.n, arcs, b);
  if (!flow.feasible) return null;
  return {
    value: fromScaled(req + flow.cost),
    method: 'min-cost-flow-balance',
    requiredLength: fromScaled(req),
    detail: 'Required arcs + minimum-cost flow that balances every intersection (in-degree = out-degree).',
  };
}
