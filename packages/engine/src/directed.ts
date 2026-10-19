import type {
  ArcBalance,
  ArcInfo,
  Baseline,
  CheckResult,
  DirectedOptimizationRecord,
  DirectedResult,
  FlowPath,
  Graph,
  Issue,
  Limits,
  RouteStep,
  TraversalKind,
  TwoWayService,
} from './types.js';
import { ENGINE_VERSION } from './version.js';
import { fromScaled, toScaled } from './units.js';
import { indexGraph, type IndexedGraph } from './graph.js';
import { validateGraph, DEFAULT_LIMITS, isOneway } from './validate.js';
import { minCostFlow, verifyFlowOptimality, decomposeFlow, type FlowArc } from './mincostflow.js';
import { verifyDirectedRoute } from './verify.js';
import { shortestCoveringWalk, STATE_SEARCH_MAX_OBLIGATIONS } from './stateSearch.js';
import { hashInput } from './solve.js';

/**
 * Directed and mixed Chinese Postman solver (one-way streets).
 *
 * Model. Every street becomes one or two ARCS (permitted directions of
 * travel): a one-way street u→v gives the single arc u→v; a two-way street
 * gives u→v (cost `weight`) and v→u (cost `reverseWeight ?? weight`). Service
 * obligations depend on `twoWay`:
 *   - 'both':   a required two-way street must be driven once in EACH direction
 *               (both kerbs, as in street sweeping); a required one-way street once, forwards.
 *   - 'either': a required two-way street must be driven once in EITHER direction
 *               (the mixed postman problem).
 *
 * Method for a fixed set R of required arcs (Edmonds & Johnson 1973, directed case):
 *   1. b(v) = in_R(v) − out_R(v). A closed walk leaves every vertex as often as it
 *      enters it, so a vertex with b(v) > 0 needs b(v) extra departures and one
 *      with b(v) < 0 needs −b(v) extra arrivals.
 *   2. The cheapest set of extra (deadhead or repeated) arcs is a minimum-cost
 *      flow that ships b(v) units out of every surplus vertex into the deficit
 *      vertices over all permitted arcs (shortest legal paths).
 *   3. R plus the flow is balanced. When the underlying undirected graph of R is
 *      connected it is also weakly connected, hence strongly connected, hence it
 *      has a directed Euler circuit (Hierholzer).
 * Its length Σc(R) + flow cost is optimal because every feasible closed walk
 * decomposes into R plus a flow satisfying the same balance constraints.
 *
 * Feasibility: such a walk exists iff every vertex touched by a required street
 * lies in one strongly connected component of the permitted-arc graph.
 *
 * 'either' (mixed) is NP-hard in general. It is solved EXACTLY here by
 * enumerating the service direction of each required two-way street (2^t
 * orientations, each solved by the flow method above, since any optimal walk
 * induces one of them). This is offered only for t ≤ mixedExactMax (default 12);
 * larger instances are rejected with an explanation rather than approximated.
 */

export interface DirectedOptions {
  depotId?: string | null;
  twoWay?: TwoWayService;
  limits?: Partial<Limits>;
  /** Maximum number of required two-way streets for exact 'either' enumeration (default 12). */
  mixedExactMax?: number;
  /** Run the independent state-space cross-check when obligations ≤ this (default 12). */
  crossCheckMaxObligations?: number;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

interface ArcModel {
  tail: number[];
  head: number[];
  cost: number[];
  edge: number[];
  ids: string[];
  /** Forward arc index (u→v) per edge. */
  fwd: number[];
  /** Reverse arc index (v→u) per edge, or −1 for one-way streets and loops. */
  back: number[];
}

function buildArcs(ig: IndexedGraph, graph: Graph): ArcModel {
  const model: ArcModel = { tail: [], head: [], cost: [], edge: [], ids: [], fwd: [], back: [] };
  const add = (t: number, h: number, c: number, k: number, id: string): number => {
    model.tail.push(t);
    model.head.push(h);
    model.cost.push(c);
    model.edge.push(k);
    model.ids.push(id);
    return model.tail.length - 1;
  };
  graph.edges.forEach((e, k) => {
    const u = ig.eu[k]!;
    const v = ig.ev[k]!;
    model.fwd.push(add(u, v, ig.ew[k]!, k, `${e.id}>`));
    if (isOneway(e) || u === v) model.back.push(-1);
    else model.back.push(add(v, u, toScaled(e.reverseWeight ?? e.weight), k, `${e.id}<`));
  });
  return model;
}

function reach(n: number, adj: number[][], next: number[], start: number): Uint8Array {
  const seen = new Uint8Array(n);
  const stack = [start];
  seen[start] = 1;
  while (stack.length > 0) {
    const v = stack.pop()!;
    for (const a of adj[v]!) {
      const w = next[a]!;
      if (!seen[w]) {
        seen[w] = 1;
        stack.push(w);
      }
    }
  }
  return seen;
}

/** Hierholzer's algorithm for a balanced, strongly connected directed multigraph. O(E). */
export function eulerCircuitDirected(n: number, tails: number[], heads: number[], start: number): { arcs: number[]; vertices: number[] } {
  const out: number[][] = Array.from({ length: n }, () => []);
  tails.forEach((t, i) => out[t]!.push(i));
  const ptr = new Int32Array(n);
  const stackV: number[] = [start];
  const stackA: number[] = [-1];
  const arcs: number[] = [];
  const vertices: number[] = [];
  while (stackV.length > 0) {
    const v = stackV[stackV.length - 1]!;
    if (ptr[v]! < out[v]!.length) {
      const a = out[v]![ptr[v]!]!;
      ptr[v] = ptr[v]! + 1;
      stackV.push(heads[a]!);
      stackA.push(a);
    } else {
      stackV.pop();
      const a = stackA.pop()!;
      if (a !== -1) {
        arcs.push(a);
        vertices.push(v);
      }
    }
  }
  arcs.reverse();
  vertices.reverse();
  return { arcs, vertices };
}

/** Single-source Dijkstra over arcs (forward or reversed), scaled integer costs. */
function arcDijkstra(n: number, adj: number[][], next: number[], cost: number[], source: number): { dist: Float64Array; pred: Int32Array } {
  const dist = new Float64Array(n).fill(Infinity);
  const pred = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[source] = 0;
  const hk: number[] = [0];
  const hv: number[] = [source];
  while (hk.length > 0) {
    // linear-scan-free binary heap pop
    const d = hk[0]!;
    const v = hv[0]!;
    const lk = hk.pop()!;
    const lv = hv.pop()!;
    if (hk.length > 0) {
      hk[0] = lk;
      hv[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < hk.length && (hk[l]! < hk[s]! || (hk[l] === hk[s] && hv[l]! < hv[s]!))) s = l;
        if (r < hk.length && (hk[r]! < hk[s]! || (hk[r] === hk[s] && hv[r]! < hv[s]!))) s = r;
        if (s === i) break;
        [hk[s], hk[i]] = [hk[i]!, hk[s]!];
        [hv[s], hv[i]] = [hv[i]!, hv[s]!];
        i = s;
      }
    }
    if (done[v] || d > dist[v]!) continue;
    done[v] = 1;
    for (const a of adj[v]!) {
      const w = next[a]!;
      const nd = d + cost[a]!;
      if (nd < dist[w]!) {
        dist[w] = nd;
        pred[w] = a;
        hk.push(nd);
        hv.push(w);
        let i = hk.length - 1;
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (hk[p]! < hk[i]! || (hk[p] === hk[i] && hv[p]! <= hv[i]!)) break;
          [hk[p], hk[i]] = [hk[i]!, hk[p]!];
          [hv[p], hv[i]] = [hv[i]!, hv[p]!];
          i = p;
        }
      }
    }
  }
  return { dist, pred };
}

export function directedDistancesFrom(graph: Graph, sourceId: string, direction: 'from' | 'to' = 'from'): Map<string, number> {
  const ig = indexGraph(graph);
  const A = buildArcs(ig, graph);
  const adj: number[][] = Array.from({ length: ig.n }, () => []);
  const next = direction === 'from' ? A.head : A.tail;
  A.tail.forEach((t, a) => (direction === 'from' ? adj[t]! : adj[A.head[a]!]!).push(a));
  const { dist } = arcDijkstra(ig.n, adj, next, A.cost, ig.vertexIndex.get(sourceId)!);
  const out = new Map<string, number>();
  dist.forEach((d, v) => {
    if (Number.isFinite(d)) out.set(ig.vertexIds[v]!, fromScaled(d));
  });
  return out;
}

/**
 * Required streets that no closed route from the depot can service legally:
 * those with an endpoint the depot cannot reach (`unreachable`) or that cannot
 * get back to the depot (`noReturn`). A vertex shares the depot's strongly
 * connected component exactly when it is reachable from it and can reach it.
 */
function classifyUnserviceable(ig: IndexedGraph, A: ArcModel, out: number[][], inc: number[][], depot: number): { unreachable: string[]; noReturn: string[] } {
  const fromDepot = reach(ig.n, out, A.head, depot);
  const toDepot = reach(ig.n, inc, A.tail, depot);
  const unreachable: string[] = [];
  const noReturn: string[] = [];
  for (let k = 0; k < ig.m; k++) {
    if (!ig.required[k]) continue;
    const ends = [ig.eu[k]!, ig.ev[k]!];
    if (ends.some((v) => !fromDepot[v])) unreachable.push(ig.edgeIds[k]!);
    else if (ends.some((v) => !toDepot[v])) noReturn.push(ig.edgeIds[k]!);
  }
  return { unreachable, noReturn };
}

/**
 * Which required streets cannot be serviced by any legal closed route from the
 * depot (default: the first vertex on a required street). Map extracts often
 * cut one-way streets at the boundary; this tells the user exactly which ones.
 */
export function findUnserviceableStreets(graph: Graph, depotId?: string | null): { unreachable: string[]; noReturn: string[] } {
  const ig = indexGraph(graph);
  const A = buildArcs(ig, graph);
  const out: number[][] = Array.from({ length: ig.n }, () => []);
  const inc: number[][] = Array.from({ length: ig.n }, () => []);
  A.tail.forEach((t, a) => {
    out[t]!.push(a);
    inc[A.head[a]!]!.push(a);
  });
  let depot = depotId != null ? (ig.vertexIndex.get(depotId) ?? -1) : -1;
  for (let v = 0; v < ig.n && depot < 0; v++) if (ig.adj[v]!.some((k) => ig.required[k] === 1)) depot = v;
  if (depot < 0) return { unreachable: [], noReturn: [] };
  return classifyUnserviceable(ig, A, out, inc, depot);
}

function failure(validation: ReturnType<typeof validateGraph>, extra: Issue[]): DirectedResult {
  return {
    ok: false,
    engine: { name: 'sweep-engine', version: ENGINE_VERSION },
    validation: { ...validation, ok: false, issues: [...validation.issues, ...extra] },
  };
}

export function solveDirectedPostman(graph: Graph, options: DirectedOptions = {}): DirectedResult {
  const t0 = now();
  const twoWay: TwoWayService = options.twoWay ?? 'both';
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const depotOpt = options.depotId ?? graph.depotId ?? null;
  const validation = validateGraph(graph, { depotId: depotOpt, limits, onewayPolicy: 'directed' });
  if (!validation.ok) return failure(validation, []);

  const ig = indexGraph(graph);
  const A = buildArcs(ig, graph);
  const nA = A.tail.length;
  const out: number[][] = Array.from({ length: ig.n }, () => []);
  const inc: number[][] = Array.from({ length: ig.n }, () => []);
  A.tail.forEach((t, a) => {
    out[t]!.push(a);
    inc[A.head[a]!]!.push(a);
  });

  // Depot: user choice, else the first vertex (input order) on a required street.
  let depot = -1;
  if (depotOpt != null) depot = ig.vertexIndex.get(depotOpt)!;
  else
    for (let v = 0; v < ig.n && depot < 0; v++) {
      if (ig.adj[v]!.some((k) => ig.required[k] === 1)) depot = v;
    }

  // --- Feasibility: required vertices must share one strongly connected component.
  const { unreachable, noReturn } = classifyUnserviceable(ig, A, out, inc, depot);
  if (unreachable.length + noReturn.length > 0) {
    const parts: string[] = [];
    if (noReturn.length > 0) parts.push(`${noReturn.length} required street(s) can be entered but there is no legal way back to the start from them (${noReturn.slice(0, 6).join(', ')}${noReturn.length > 6 ? '…' : ''})`);
    if (unreachable.length > 0) parts.push(`${unreachable.length} required street(s) cannot be reached from the start by legal driving (${unreachable.slice(0, 6).join(', ')}${unreachable.length > 6 ? '…' : ''})`);
    return failure(validation, [
      {
        code: 'DIRECTED_INFEASIBLE',
        severity: 'error',
        message: `No closed route can service every required street while obeying the one-way restrictions: ${parts.join('; ')}. A closed route exists only if every required street lies in one strongly connected part of the network. Make those streets optional, change a one-way restriction, or add a connecting street.`,
        edgeIds: [...noReturn, ...unreachable],
      },
    ]);
  }

  // --- Service obligations.
  const fixedRequired: number[] = [];
  const choice: Array<[number, number]> = [];
  let requiredScaledLowerBound = 0;
  for (let k = 0; k < ig.m; k++) {
    if (!ig.required[k]) continue;
    const f = A.fwd[k]!;
    const b = A.back[k]!;
    if (b < 0) {
      fixedRequired.push(f);
      requiredScaledLowerBound += A.cost[f]!;
    } else if (twoWay === 'both') {
      fixedRequired.push(f, b);
      requiredScaledLowerBound += A.cost[f]! + A.cost[b]!;
    } else {
      choice.push([f, b]);
      requiredScaledLowerBound += Math.min(A.cost[f]!, A.cost[b]!);
    }
  }
  const mixedMax = options.mixedExactMax ?? 12;
  if (choice.length > mixedMax) {
    return failure(validation, [
      {
        code: 'MIXED_TOO_LARGE',
        severity: 'error',
        message: `Servicing ${choice.length} two-way streets "in either direction" is the mixed Chinese Postman Problem, which is NP-hard. SWEEP solves it exactly only up to ${mixedMax} required two-way streets (by checking all 2^t service directions). Choose "service both directions", which is solved exactly for any size, or reduce the required two-way streets.`,
      },
    ]);
  }

  const flowArcs: FlowArc[] = A.tail.map((t, a) => ({ tail: t, head: A.head[a]!, cost: A.cost[a]! }));
  const supplyFor = (req: number[]): Float64Array => {
    const b = new Float64Array(ig.n);
    for (const a of req) {
      b[A.head[a]!] = b[A.head[a]!]! + 1;
      b[A.tail[a]!] = b[A.tail[a]!]! - 1;
    }
    return b;
  };
  const tValidate = now();

  // --- Balance by minimum-cost flow (once per orientation for 'either').
  let best: { req: number[]; supply: Float64Array; flow: ReturnType<typeof minCostFlow>; total: number } | null = null;
  const orientations = 2 ** choice.length;
  for (let mask = 0; mask < orientations; mask++) {
    const req = fixedRequired.slice();
    choice.forEach(([f, b], i) => req.push(mask & (1 << i) ? b : f));
    const supply = supplyFor(req);
    const flow = minCostFlow(ig.n, flowArcs, supply);
    if (!flow.feasible) throw new Error('Internal: flow infeasible despite strong connectivity');
    const total = req.reduce((s, a) => s + A.cost[a]!, 0) + flow.cost;
    if (!best || total < best.total) best = { req, supply, flow, total };
  }
  const tFlow = now();
  const { req, supply, flow } = best!;
  const certificate = verifyFlowOptimality(ig.n, flowArcs, supply, flow.flow, flow.potential);

  // --- Augmentation: required arcs once + flow decomposed into shortest legal paths.
  const decomposition = decomposeFlow(ig.n, flowArcs, supply, flow.flow);
  const augArcs: number[] = req.slice().sort((a, b) => a - b);
  const addedCopies = new Map<number, number>();
  for (const p of decomposition.paths) {
    for (const a of p.arcs) addedCopies.set(a, (addedCopies.get(a) ?? 0) + p.units);
  }
  for (const [a, c] of [...addedCopies.entries()].sort((x, y) => x[0] - y[0])) for (let i = 0; i < c; i++) augArcs.push(a);
  const addedScaled = [...addedCopies.entries()].reduce((s, [a, c]) => s + c * A.cost[a]!, 0);
  const requiredScaled = req.reduce((s, a) => s + A.cost[a]!, 0);
  const net = new Int32Array(ig.n);
  for (const a of augArcs) {
    net[A.tail[a]!] = net[A.tail[a]!]! + 1;
    net[A.head[a]!] = net[A.head[a]!]! - 1;
  }
  const balanced = net.every((x) => x === 0);
  if (!balanced) throw new Error('Internal: augmented multigraph is not balanced');

  // --- Directed Euler circuit.
  const tails = augArcs.map((a) => A.tail[a]!);
  const heads = augArcs.map((a) => A.head[a]!);
  const circuit = eulerCircuitDirected(ig.n, tails, heads, depot);
  const tEuler = now();
  if (circuit.arcs.length !== augArcs.length) throw new Error('Internal: augmented multigraph is not strongly connected');

  // --- Route steps, classified against the service obligations.
  const obligationOf = (a: number): string | null => {
    const k = A.edge[a]!;
    if (!ig.required[k]) return null;
    if (twoWay === 'either' || A.back[k]! < 0) return `${k}`;
    return `${k}:${a === A.fwd[k] ? 'f' : 'b'}`;
  };
  const fulfilled = new Set<string>();
  const steps: RouteStep[] = [];
  let cumulative = 0;
  let prev = depot;
  for (let s = 0; s < circuit.arcs.length; s++) {
    const a = augArcs[circuit.arcs[s]!]!;
    const k = A.edge[a]!;
    const ob = obligationOf(a);
    let kind: TraversalKind;
    if (!ig.required[k]) kind = 'deadhead';
    else if (ob !== null && !fulfilled.has(ob)) {
      kind = 'service';
      fulfilled.add(ob);
    } else kind = 'repeat';
    cumulative += A.cost[a]!;
    steps.push({
      index: s,
      edgeId: ig.edgeIds[k]!,
      from: ig.vertexIds[prev]!,
      to: ig.vertexIds[circuit.vertices[s]!]!,
      weight: fromScaled(A.cost[a]!),
      kind,
      cumulative: fromScaled(cumulative),
    });
    prev = circuit.vertices[s]!;
  }
  const totalScaled = requiredScaled + addedScaled;
  const traversalCounts: Record<string, number> = {};
  for (const id of ig.edgeIds) traversalCounts[id] = 0;
  for (const st of steps) traversalCounts[st.edgeId] = (traversalCounts[st.edgeId] ?? 0) + 1;

  // --- Independent verification and cross-check.
  const depotId = ig.vertexIds[depot]!;
  const verification = verifyDirectedRoute(graph, steps, { depotId, twoWay, expectedTotal: fromScaled(totalScaled) });
  const obligationsCount = twoWay === 'both' ? fixedRequired.length : fixedRequired.length + choice.length;
  let crossCheckCost: number | null = null;
  const crossMax = Math.min(options.crossCheckMaxObligations ?? 12, STATE_SEARCH_MAX_OBLIGATIONS);
  if (obligationsCount <= crossMax && ig.n * 2 ** obligationsCount <= 2_000_000) {
    crossCheckCost = shortestCoveringWalk(graph, { depotId, twoWay, maxStates: 2_000_000 });
  }
  const checks: CheckResult[] = [
    ...verification.checks,
    {
      id: 'balance',
      label: 'Augmented graph is balanced (in-degree = out-degree)',
      passed: balanced,
      detail: `Every vertex is entered as often as it is left after adding ${[...addedCopies.values()].reduce((s, c) => s + c, 0)} arc copies.`,
    },
    {
      id: 'flow-cost',
      label: 'Added distance equals the minimum-cost flow',
      passed: addedScaled === flow.cost && decomposition.cancelledCycleCost === 0,
      detail: `Added ${fromScaled(addedScaled)} vs flow cost ${fromScaled(flow.cost)}.`,
    },
    {
      id: 'flow-certificate',
      label: 'Flow optimality certificate (LP duality)',
      passed: certificate.ok,
      detail: certificate.ok ? 'Node potentials give every permitted arc a non-negative reduced cost and every used arc zero reduced cost, so no cheaper balancing exists.' : certificate.detail,
    },
  ];
  if (crossCheckCost !== null) {
    checks.push({
      id: 'state-search-cross-check',
      label: 'Independent state-space search agrees',
      passed: crossCheckCost === fromScaled(totalScaled),
      detail: `Shortest covering closed walk found by exhaustive search over (vertex, serviced set): ${crossCheckCost} · solver: ${fromScaled(totalScaled)}.`,
    });
  }
  const tVerify = now();

  // --- Baselines.
  const baselines: Baseline[] = [
    {
      id: 'lower-bound',
      label: 'Lower bound',
      total: fromScaled(requiredScaledLowerBound),
      isValidRoute: false,
      description: twoWay === 'both' ? 'Sum of all required directions. Achievable only if every intersection is already balanced.' : 'Sum of required streets in their cheaper permitted direction. No route can be shorter.',
    },
    greedyBalancingBaseline(ig.n, A, out, req, supply),
    returnAfterEachBaseline(ig.n, A, out, req),
  ];

  const balance: ArcBalance[] = [];
  const inR = new Int32Array(ig.n);
  const outR = new Int32Array(ig.n);
  for (const a of req) {
    inR[A.head[a]!] = inR[A.head[a]!]! + 1;
    outR[A.tail[a]!] = outR[A.tail[a]!]! + 1;
  }
  for (let v = 0; v < ig.n; v++) {
    if (inR[v] === 0 && outR[v] === 0) continue;
    balance.push({ vertexId: ig.vertexIds[v]!, inRequired: inR[v]!, outRequired: outR[v]!, delta: inR[v]! - outR[v]! });
  }
  const reqSet = new Set(req);
  const arcs: ArcInfo[] = A.tail.map((t, a) => ({
    id: A.ids[a]!,
    edgeId: ig.edgeIds[A.edge[a]!]!,
    from: ig.vertexIds[t]!,
    to: ig.vertexIds[A.head[a]!]!,
    weight: fromScaled(A.cost[a]!),
    required: reqSet.has(a),
  }));
  const paths: FlowPath[] = decomposition.paths.map((p) => ({
    from: ig.vertexIds[p.from]!,
    to: ig.vertexIds[p.to]!,
    units: p.units,
    distance: fromScaled(p.arcs.reduce((s, a) => s + A.cost[a]!, 0)),
    pathVertices: [ig.vertexIds[p.from]!, ...p.arcs.map((a) => ig.vertexIds[A.head[a]!]!)],
    pathEdgeIds: p.arcs.map((a) => ig.edgeIds[A.edge[a]!]!),
    pathArcIds: p.arcs.map((a) => A.ids[a]!),
  }));
  const addedEdgeCopies: Record<string, number> = {};
  for (const [a, c] of [...addedCopies.entries()].sort((x, y) => x[0] - y[0])) {
    const id = ig.edgeIds[A.edge[a]!]!;
    addedEdgeCopies[id] = (addedEdgeCopies[id] ?? 0) + c;
  }

  const passedAll = checks.every((c) => c.passed);
  const allRequired = ig.required.every((r) => r === 1);
  const mixed = twoWay === 'either' && choice.length > 0;
  const problem: DirectedOptimizationRecord['algorithm']['problem'] = mixed
    ? 'mixed-chinese-postman-exact-enumeration'
    : allRequired
      ? 'directed-chinese-postman'
      : 'directed-rural-postman-connected-required';
  const record: DirectedOptimizationRecord = {
    ok: true,
    mode: 'directed',
    engine: { name: 'sweep-engine', version: ENGINE_VERSION },
    algorithm: {
      problem,
      twoWay,
      shortestPaths: 'dijkstra-reduced-costs',
      balancing: flow.cost > 0 || decomposition.paths.length > 0 ? 'min-cost-flow-ssp' : 'none',
      orientationSearch: twoWay === 'either' ? { twoWayRequired: choice.length, orientationsEvaluated: orientations } : null,
      euler: 'hierholzer-directed',
      optimal: passedAll,
      optimalityBasis: passedAll
        ? 'Optimal: route = required arcs + minimum-cost flow that balances in- and out-degrees (Edmonds–Johnson, directed). The flow is certified optimal by LP duality' +
          (mixed ? `, and all ${orientations} service-direction choices for the ${choice.length} two-way required street(s) were solved and compared` : '') +
          (crossCheckCost !== null ? '; an independent exhaustive state-space search confirms the total.' : '.')
        : 'Not certified: at least one verification check failed (see checks).',
    },
    input: {
      graphHash: hashInput(graph, depotId, { mode: 'directed', twoWay }),
      ...(graph.name ? { name: graph.name } : {}),
      depotId,
      vertexCount: ig.n,
      edgeCount: ig.m,
      arcCount: nA,
      requiredArcCount: req.length,
      onewayEdgeCount: graph.edges.filter(isOneway).length,
      requiredEdgeCount: validation.stats.requiredEdgeCount,
      optionalEdgeCount: validation.stats.optionalEdgeCount,
    },
    arcs,
    balance,
    imbalancedVertexIds: balance.filter((b) => b.delta !== 0).map((b) => b.vertexId),
    flow: {
      paths,
      cost: fromScaled(flow.cost),
      totalUnits: paths.reduce((s, p) => s + p.units, 0),
      dualCertificateVerified: certificate.ok,
      crossCheckCost,
    },
    augmentation: {
      addedCopies: Object.fromEntries([...addedCopies.entries()].sort((x, y) => x[0] - y[0]).map(([a, c]) => [A.ids[a]!, c])),
      addedEdgeCopies,
      addedDistance: fromScaled(addedScaled),
      balanced,
    },
    route: {
      steps,
      totalDistance: fromScaled(totalScaled),
      requiredDistance: fromScaled(requiredScaled),
      repeatedDistance: fromScaled(addedScaled),
      repeatedRequiredTraversals: steps.filter((s) => s.kind === 'repeat').length,
      deadheadTraversals: steps.filter((s) => s.kind === 'deadhead').length,
      traversalCounts,
      wrongWayTraversals: 0,
    },
    baselines,
    checks,
    warnings: validation.issues.filter((i) => i.severity !== 'error'),
    timingsMs: {
      validate: r3(tValidate - t0),
      flow: r3(tFlow - tValidate),
      euler: r3(tEuler - tFlow),
      verify: r3(tVerify - tEuler),
      total: r3(now() - t0),
    },
  };
  return record;
}

/**
 * Baseline: balance greedily — repeatedly join the closest (surplus, deficit)
 * pair by a shortest legal path. Always a valid closed route (balanced and
 * connected), never better than the min-cost flow.
 */
function greedyBalancingBaseline(n: number, A: ArcModel, out: number[][], req: number[], supply: Float64Array): Baseline {
  const sources: number[] = [];
  for (let v = 0; v < n; v++) if (supply[v]! > 0) sources.push(v);
  const base = req.reduce((s, a) => s + A.cost[a]!, 0);
  const label = 'Greedy balancing';
  const description = 'Same construction, but each surplus intersection is joined to its nearest deficit intersection greedily instead of by the minimum-cost flow.';
  if (sources.length > 400) return { id: 'greedy-balancing', label, total: null, isValidRoute: true, description: `${description} Skipped for ${sources.length} surplus intersections.` };
  const dist = sources.map((s) => arcDijkstra(n, out, A.head, A.cost, s).dist);
  const sup = Float64Array.from(supply);
  let added = 0;
  for (;;) {
    let bi = -1;
    let bt = -1;
    let bd = Infinity;
    sources.forEach((s, i) => {
      if (sup[s]! <= 0) return;
      for (let t = 0; t < n; t++) if (sup[t]! < 0 && dist[i]![t]! < bd) {
        bd = dist[i]![t]!;
        bi = i;
        bt = t;
      }
    });
    if (bi < 0) break;
    const s = sources[bi]!;
    const units = Math.min(sup[s]!, -sup[bt]!);
    added += units * bd;
    sup[s] = sup[s]! - units;
    sup[bt] = sup[bt]! + units;
  }
  return { id: 'greedy-balancing', label, total: fromScaled(base + added), isValidRoute: true, description };
}

/**
 * Baseline: drive each required direction, then return to its start by the
 * shortest legal path. The union of these loops is balanced and connected,
 * so it is a valid closed route.
 */
function returnAfterEachBaseline(n: number, A: ArcModel, out: number[][], req: number[]): Baseline {
  const label = 'Return after every street';
  const description = 'Drive each required street, then immediately return to where it began by the shortest legal path. Always valid; never better than optimal.';
  const heads = [...new Set(req.map((a) => A.head[a]!))];
  if (heads.length > 400) return { id: 'return-after-each', label, total: null, isValidRoute: true, description: `${description} Skipped for large networks.` };
  const distFrom = new Map(heads.map((h) => [h, arcDijkstra(n, out, A.head, A.cost, h).dist]));
  let total = 0;
  for (const a of req) total += A.cost[a]! + (A.tail[a] === A.head[a] ? 0 : distFrom.get(A.head[a]!)![A.tail[a]!]!);
  return { id: 'return-after-each', label, total: fromScaled(total), isValidRoute: true, description };
}
