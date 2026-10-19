import type { Graph, RouteStep } from '../types.js';
import { fromScaled } from '../units.js';
import { eulerCircuit } from '../euler.js';
import { maxWeightMatching, type WeightedEdgeList } from '../matching/blossom.js';
import { arcDijkstra, buildArcGraph, treePath, type ArcGraph } from './arcs.js';

/**
 * Scalable undirected coverage heuristic for zones with more odd-degree
 * intersections than exact matching handles interactively.
 *
 * Edmonds–Johnson structure (pair the odd vertices, duplicate shortest paths,
 * Euler circuit) with one restriction: the pairing is chosen among CANDIDATE
 * pairs, each odd vertex's `candidates` nearest other odd vertices by network
 * distance (bounded Dijkstra; distances exact).
 *  1. Maximum-cardinality minimum-cost matching on the candidate graph
 *     (Edmonds' blossom, the same implementation as the exact solver). It is
 *     optimal AMONG CANDIDATE PAIRS, not over all pairings.
 *  2. Vertices the candidate graph cannot match are paired greedily with their
 *     nearest unmatched odd vertex (exact distances).
 *  3. Pair-exchange improvement: (a,b),(c,d) → (a,c),(b,d) or (a,d),(b,c)
 *     whenever the needed distances are known and the total decreases.
 *  4. Shortest paths of the pairs are duplicated and Hierholzer's algorithm
 *     gives the closed route.
 * The result is a valid route (verified independently by the caller); it is
 * NOT claimed optimal. Its quality is reported as a gap to a valid lower bound.
 */

export interface HeuristicOptions {
  depot: number;
  candidates?: number;
  /** Skip the blossom step above this many odd vertices (greedy + exchange only). */
  blossomMax?: number;
  /** Maximum improvement passes over all pairs. */
  maxPasses?: number;
}

export interface HeuristicResult {
  steps: RouteStep[];
  total: number;
  oddVertices: number;
  candidatePairs: number;
  pairs: number;
  matchedByBlossom: number;
  matchedGreedily: number;
  exchanges: number;
  matchingCost: number;
  blossomUsed: boolean;
  /** LP certificate of the blossom on the candidate graph (optimality among candidate pairs only). */
  candidateCertificate: boolean;
  timingsMs: { candidates: number; matching: number; improve: number; euler: number };
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function undirectedCoverageHeuristic(graph: Graph, opts: HeuristicOptions): HeuristicResult {
  const K = opts.candidates ?? 10;
  const ag: ArcGraph = buildArcGraph(graph, false);
  const deg = new Int32Array(ag.n);
  graph.edges.forEach((e, k) => {
    if (!e.required) return;
    const a = ag.fwdArc[k]!;
    deg[ag.arcTail[a]!] = deg[ag.arcTail[a]!]! + 1;
    deg[ag.arcHead[a]!] = deg[ag.arcHead[a]!]! + 1;
  });
  const T: number[] = [];
  for (let v = 0; v < ag.n; v++) if (deg[v]! % 2 === 1) T.push(v);
  const k = T.length;
  const idx = new Int32Array(ag.n).fill(-1);
  T.forEach((v, i) => (idx[v] = i));

  // 1. Candidate pairs with exact network distances.
  const t0 = now();
  const known = new Map<number, number>();
  const key = (i: number, j: number): number => (i < j ? i * k + j : j * k + i);
  const cand: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < k; i++) {
    let found = 0;
    arcDijkstra(ag, [T[i]!], {
      stop: (v, d) => {
        const j = idx[v]!;
        if (j >= 0 && j !== i) {
          cand[i]!.push(j);
          known.set(key(i, j), d);
          found++;
        }
        return found >= K;
      },
    });
  }
  const t1 = now();

  // 2. Blossom on the candidate graph (max cardinality, then min cost).
  const mate = new Int32Array(k).fill(-1);
  let blossomUsed = false;
  let candidateCertificate = false;
  let matchedByBlossom = 0;
  if (k > 0 && k <= (opts.blossomMax ?? 4000)) {
    let maxD = 0;
    for (const d of known.values()) if (d > maxD) maxD = d;
    const W = maxD + 1;
    const edges: WeightedEdgeList = [];
    for (const [kk, d] of known) {
      const i = Math.floor(kk / k);
      const j = kk % k;
      edges.push([i, j, W - d]);
    }
    const res = maxWeightMatching(edges, true);
    blossomUsed = true;
    candidateCertificate = res.certificateVerified;
    for (let i = 0; i < res.mate.length && i < k; i++) mate[i] = res.mate[i]!;
    for (let i = 0; i < k; i++) if (mate[i]! >= 0) matchedByBlossom++;
  }
  // 3. Greedy completion with exact distances (nearest unmatched).
  let matchedGreedily = 0;
  const unmatched = new Set<number>();
  for (let i = 0; i < k; i++) if (mate[i]! < 0) unmatched.add(i);
  for (let i = 0; i < k; i++) {
    if (!unmatched.has(i)) continue;
    unmatched.delete(i);
    let partner = -1;
    arcDijkstra(ag, [T[i]!], {
      stop: (v, d) => {
        const j = idx[v]!;
        if (j >= 0 && unmatched.has(j)) {
          partner = j;
          known.set(key(i, j), d);
          return true;
        }
        return false;
      },
    });
    if (partner < 0) throw new Error('undirectedCoverageHeuristic: odd vertices in different network parts');
    unmatched.delete(partner);
    mate[i] = partner;
    mate[partner] = i;
    matchedGreedily += 2;
  }
  const t2 = now();

  // 4. Pair exchange with known distances.
  const dist = (i: number, j: number): number | undefined => known.get(key(i, j));
  let exchanges = 0;
  for (let pass = 0; pass < (opts.maxPasses ?? 8); pass++) {
    let improved = false;
    for (let a = 0; a < k; a++) {
      const b = mate[a]!;
      for (const c of cand[a]!) {
        const d = mate[c]!;
        if (c === b || d === a) continue;
        const ab = dist(a, b)!;
        const cd = dist(c, d)!;
        const ac = dist(a, c)!;
        const bd = dist(b, d);
        if (bd !== undefined && ac + bd < ab + cd) {
          mate[a] = c;
          mate[c] = a;
          mate[b] = d;
          mate[d] = b;
          exchanges++;
          improved = true;
          break;
        }
        const ad = dist(a, d);
        const bc = dist(b, c);
        if (ad !== undefined && bc !== undefined && ad + bc < ab + cd) {
          mate[a] = d;
          mate[d] = a;
          mate[b] = c;
          mate[c] = b;
          exchanges++;
          improved = true;
          break;
        }
      }
    }
    if (!improved) break;
  }
  const t3 = now();

  // 5. Augment along shortest paths and walk an Euler circuit.
  const ends: Array<[number, number]> = [];
  const endEdge: number[] = [];
  graph.edges.forEach((e, kk) => {
    if (!e.required) return;
    const a = ag.fwdArc[kk]!;
    ends.push([ag.arcTail[a]!, ag.arcHead[a]!]);
    endEdge.push(kk);
  });
  let matchingCost = 0;
  let pairs = 0;
  for (let i = 0; i < k; i++) {
    const j = mate[i]!;
    if (j < i) continue;
    pairs++;
    const target = T[j]!;
    const tree = arcDijkstra(ag, [T[i]!], { stop: (v) => v === target });
    matchingCost += tree.dist[target]!;
    for (const a of treePath(ag, tree, target)) {
      ends.push([ag.arcTail[a]!, ag.arcHead[a]!]);
      endEdge.push(ag.arcEdge[a]!);
    }
  }
  const circuit = eulerCircuit(ag.n, ends, opts.depot);
  if (circuit.edges.length !== ends.length) throw new Error('undirectedCoverageHeuristic: augmented required network is not connected');
  const t4 = now();
  const steps: RouteStep[] = [];
  const seen = new Set<number>();
  let cum = 0;
  let prev = opts.depot;
  for (let s = 0; s < circuit.edges.length; s++) {
    const kk = endEdge[circuit.edges[s]!]!;
    const e = graph.edges[kk]!;
    const next = circuit.vertices[s]!;
    const w = ag.arcCost[ag.fwdArc[kk]!]!;
    cum += w;
    steps.push({
      index: s,
      edgeId: e.id,
      from: ag.vertexIds[prev]!,
      to: ag.vertexIds[next]!,
      weight: e.weight,
      kind: !e.required ? 'deadhead' : seen.has(kk) ? 'repeat' : 'service',
      cumulative: fromScaled(cum),
    });
    if (e.required) seen.add(kk);
    prev = next;
  }
  return {
    steps,
    total: fromScaled(cum),
    oddVertices: k,
    candidatePairs: known.size,
    pairs,
    matchedByBlossom,
    matchedGreedily,
    exchanges,
    matchingCost: fromScaled(matchingCost),
    blossomUsed,
    candidateCertificate,
    timingsMs: { candidates: t1 - t0, matching: t2 - t1, improve: t3 - t2, euler: t4 - t3 },
  };
}
