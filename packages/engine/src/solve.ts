import type {
  Baseline,
  CheckResult,
  DegreeInfo,
  Graph,
  MatchedPair,
  OptimizationRecord,
  OptimizationResult,
  RouteStep,
  SolveOptions,
  TraversalKind,
} from './types.js';
import { ENGINE_VERSION } from './version.js';
import { fromScaled } from './units.js';
import { indexGraph } from './graph.js';
import { dijkstra, reconstructPath, type ShortestPathTree } from './dijkstra.js';
import { validateGraph, DEFAULT_LIMITS } from './validate.js';
import { minCostPerfectMatchingComplete } from './matching/blossom.js';
import { dpMinCostPerfectMatching } from './matching/dp.js';
import { greedyPairing } from './matching/greedy.js';
import { eulerCircuit } from './euler.js';
import { verifyRoute } from './verify.js';
import { canonicalJson, sha256Hex } from './sha256.js';

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Stable hash of the optimisation input (graph semantics + options). */
export function hashInput(graph: Graph, depotId: string | null): string {
  const canonical = {
    vertices: graph.vertices.map((v) => ({ id: v.id, x: v.x, y: v.y })),
    edges: graph.edges.map((e) => ({ id: e.id, u: e.u, v: e.v, w: e.weight, r: e.required })),
    depotId,
    engine: ENGINE_VERSION,
  };
  return sha256Hex(canonicalJson(canonical));
}

/**
 * Solve the undirected Chinese Postman Problem (all edges required) or its
 * generalisation in which only some edges are required but the required edges
 * form a connected subgraph. In the latter case optional edges may be used for
 * repositioning ("deadheading").
 *
 * Method (Edmonds & Johnson, 1973): the optimal closed walk traverses every
 * required edge once plus a minimum-cost T-join, where T is the set of
 * odd-degree vertices of the required subgraph. A minimum-cost T-join is
 * obtained by a minimum-cost perfect matching on T under shortest-path
 * distances, expanded back into shortest paths. The augmented multigraph is
 * connected and Eulerian, so Hierholzer's algorithm yields the route.
 */
export function solveChinesePostman(graph: Graph, options: SolveOptions = {}): OptimizationResult {
  const t0 = now();
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const validation = validateGraph(graph, { depotId: options.depotId ?? graph.depotId ?? null, limits });
  const tValidate = now();
  if (!validation.ok) return { ok: false, engine: { name: 'sweep-engine', version: ENGINE_VERSION }, validation };

  const ig = indexGraph(graph);
  const requiredDegree = new Int32Array(ig.n);
  let requiredScaled = 0;
  for (let k = 0; k < ig.m; k++) {
    if (!ig.required[k]) continue;
    requiredScaled += ig.ew[k]!;
    requiredDegree[ig.eu[k]!] = requiredDegree[ig.eu[k]!]! + 1;
    requiredDegree[ig.ev[k]!] = requiredDegree[ig.ev[k]!]! + 1;
  }
  const allRequired = ig.required.every((r) => r === 1);

  // Depot: user choice, else the first vertex (input order) on a required edge.
  let depot = -1;
  const depotId = options.depotId ?? graph.depotId ?? null;
  if (depotId != null) depot = ig.vertexIndex.get(depotId)!;
  else for (let v = 0; v < ig.n && depot < 0; v++) if (requiredDegree[v]! > 0) depot = v;

  const degrees: DegreeInfo[] = [];
  const odd: number[] = [];
  for (let v = 0; v < ig.n; v++) {
    if (requiredDegree[v] === 0) continue;
    const isOdd = requiredDegree[v]! % 2 === 1;
    degrees.push({ vertexId: ig.vertexIds[v]!, requiredDegree: requiredDegree[v]!, odd: isOdd });
    if (isOdd) odd.push(v);
  }
  const k = odd.length;
  if (k > limits.maxOddVertices) {
    return {
      ok: false,
      engine: { name: 'sweep-engine', version: ENGINE_VERSION },
      validation: {
        ...validation,
        ok: false,
        issues: [
          ...validation.issues,
          {
            code: 'LIMIT_EXCEEDED',
            severity: 'error',
            message: `This network has ${k} odd-degree intersections; exact matching is supported up to ${limits.maxOddVertices} (O(k³) time). Reduce the required streets or split the area.`,
          },
        ],
      },
    };
  }

  // --- Shortest paths between odd vertices ---------------------------------
  const trees: ShortestPathTree[] = odd.map((s) => dijkstra(ig, [s]));
  const dist = (i: number, j: number): number => trees[i]!.dist[odd[j]!]!;
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    if (!Number.isFinite(dist(i, j))) throw new Error('Internal: odd vertices disconnected despite validation');
  }
  const tPaths = now();

  // --- Exact minimum-cost perfect matching ---------------------------------
  let mate: Int32Array = new Int32Array(0);
  let matchingCost = 0;
  let certificateVerified = true;
  let crossCheckCost: number | null = null;
  let optimalPairingCount: number | null = null;
  const crossCheckMax = options.crossCheckMaxOdd ?? 16;
  if (k > 0) {
    const res = minCostPerfectMatchingComplete(k, dist);
    mate = res.mate;
    matchingCost = res.total;
    certificateVerified = res.certificateVerified;
    if (k <= crossCheckMax) {
      const dp = dpMinCostPerfectMatching(k, dist);
      crossCheckCost = dp.total;
      optimalPairingCount = dp.optimalCount;
    }
  }
  const tMatch = now();

  // --- Augmentation: duplicate the matched shortest paths ------------------
  const pairs: MatchedPair[] = [];
  const addedCopies = new Map<number, number>();
  for (let i = 0; i < k; i++) {
    const j = mate[i]!;
    if (j < i) continue;
    const path = reconstructPath(ig, trees[i]!, odd[j]!);
    for (const e of path.edges) addedCopies.set(e, (addedCopies.get(e) ?? 0) + 1);
    pairs.push({
      a: ig.vertexIds[odd[i]!]!,
      b: ig.vertexIds[odd[j]!]!,
      distance: fromScaled(dist(i, j)),
      pathVertices: path.vertices.map((v) => ig.vertexIds[v]!),
      pathEdgeIds: path.edges.map((e) => ig.edgeIds[e]!),
    });
  }

  // Augmented multigraph: each required edge once, plus every added copy.
  const augEdge: number[] = [];
  const augEnds: Array<[number, number]> = [];
  for (let e = 0; e < ig.m; e++) {
    if (!ig.required[e]) continue;
    augEdge.push(e);
    augEnds.push([ig.eu[e]!, ig.ev[e]!]);
  }
  for (const [e, c] of [...addedCopies.entries()].sort((a, b) => a[0] - b[0])) {
    for (let x = 0; x < c; x++) {
      augEdge.push(e);
      augEnds.push([ig.eu[e]!, ig.ev[e]!]);
    }
  }
  const augDeg = new Int32Array(ig.n);
  for (const [u, v] of augEnds) {
    augDeg[u] = augDeg[u]! + 1;
    augDeg[v] = augDeg[v]! + 1;
  }
  const allDegreesEven = augDeg.every((d) => d % 2 === 0);
  if (!allDegreesEven) throw new Error('Internal: augmented multigraph has an odd-degree vertex');

  // --- Euler circuit --------------------------------------------------------
  const circuit = eulerCircuit(ig.n, augEnds, depot);
  const tEuler = now();
  if (circuit.edges.length !== augEdge.length) throw new Error('Internal: augmented multigraph is not connected');

  const seen = new Uint8Array(ig.m);
  const steps: RouteStep[] = [];
  let cumulative = 0;
  let prev = depot;
  let repeatedRequiredTraversals = 0;
  let deadheadTraversals = 0;
  for (let s = 0; s < circuit.edges.length; s++) {
    const e = augEdge[circuit.edges[s]!]!;
    const to = circuit.vertices[s]!;
    let kind: TraversalKind;
    if (!ig.required[e]) {
      kind = 'deadhead';
      deadheadTraversals++;
    } else if (seen[e]) {
      kind = 'repeat';
      repeatedRequiredTraversals++;
    } else kind = 'service';
    seen[e] = 1;
    cumulative += ig.ew[e]!;
    steps.push({
      index: s,
      edgeId: ig.edgeIds[e]!,
      from: ig.vertexIds[prev]!,
      to: ig.vertexIds[to]!,
      weight: fromScaled(ig.ew[e]!),
      kind,
      cumulative: fromScaled(cumulative),
    });
    prev = to;
  }

  const traversalCounts: Record<string, number> = {};
  for (const id of ig.edgeIds) traversalCounts[id] = 0;
  for (const st of steps) traversalCounts[st.edgeId] = (traversalCounts[st.edgeId] ?? 0) + 1;

  const addedScaled = [...addedCopies.entries()].reduce((s, [e, c]) => s + c * ig.ew[e]!, 0);
  const totalScaled = requiredScaled + addedScaled;

  // --- Independent verification -------------------------------------------
  const verification = verifyRoute(graph, steps, { depotId: ig.vertexIds[depot]!, expectedTotal: fromScaled(totalScaled) });
  const checks: CheckResult[] = [
    ...verification.checks,
    {
      id: 'parity',
      label: 'Augmented graph is Eulerian',
      passed: allDegreesEven,
      detail: allDegreesEven ? 'Every vertex has even degree after adding the matched shortest paths.' : 'Some vertex has odd degree.',
    },
    {
      id: 'matching-perfect',
      label: 'Matching pairs every odd vertex exactly once',
      passed: pairs.length * 2 === k && new Set(pairs.flatMap((p) => [p.a, p.b])).size === k,
      detail: `${k} odd vertices → ${pairs.length} pairs.`,
    },
    {
      id: 'matching-cost',
      label: 'Added distance equals the matching cost',
      passed: addedScaled === matchingCost,
      detail: `Added ${fromScaled(addedScaled)} vs matching cost ${fromScaled(matchingCost)}.`,
    },
    {
      id: 'dual-certificate',
      label: 'Matching optimality certificate (LP duality)',
      passed: certificateVerified,
      detail: k <= 2 ? 'Trivial: at most one possible pairing.' : certificateVerified ? 'Dual feasibility and complementary slackness hold, so no cheaper pairing exists.' : 'Certificate failed.',
    },
  ];
  if (crossCheckCost !== null) {
    checks.push({
      id: 'dp-cross-check',
      label: 'Independent subset-DP matching agrees',
      passed: crossCheckCost === matchingCost,
      detail: `Blossom cost ${fromScaled(matchingCost)} · DP cost ${fromScaled(crossCheckCost)}.`,
    });
  }
  const tVerify = now();

  // --- Baselines -------------------------------------------------------------
  const greedy = k > 0 ? greedyPairing(k, dist) : { pairs: [], total: 0 };
  const baselines: Baseline[] = [
    {
      id: 'lower-bound',
      label: 'Lower bound',
      total: fromScaled(requiredScaled),
      isValidRoute: k === 0,
      description: 'Sum of required street lengths. No route can be shorter; it is achievable only when every intersection has even degree.',
    },
    {
      id: 'greedy-pairing',
      label: 'Greedy pairing',
      total: fromScaled(requiredScaled + greedy.total),
      isValidRoute: true,
      description: 'Same method, but odd intersections are paired greedily (closest pair first) instead of by exact minimum matching.',
    },
    {
      id: 'double-every-street',
      label: 'Out-and-back on every street',
      total: fromScaled(2 * requiredScaled),
      isValidRoute: true,
      description: 'Traverse every required street twice. Always a valid closed route, never better than optimal.',
    },
  ];

  const passedAll = checks.every((c) => c.passed);
  const record: OptimizationRecord = {
    ok: true,
    engine: { name: 'sweep-engine', version: ENGINE_VERSION },
    algorithm: {
      problem: allRequired ? 'undirected-chinese-postman' : 'undirected-rural-postman-connected-required',
      shortestPaths: 'dijkstra-binary-heap',
      matching: k > 0 ? 'edmonds-blossom' : 'none',
      matchingCrossCheck: crossCheckCost !== null ? 'subset-dp' : 'skipped',
      euler: 'hierholzer',
      optimal: passedAll,
      optimalityBasis: passedAll
        ? 'Optimal: route = required streets + minimum-cost T-join (Edmonds–Johnson). The matching is certified optimal by LP duality' +
          (crossCheckCost !== null ? ' and independently confirmed by exhaustive subset DP.' : '.')
        : 'Not certified: at least one verification check failed (see checks).',
    },
    input: {
      graphHash: hashInput(graph, ig.vertexIds[depot]!),
      ...(graph.name ? { name: graph.name } : {}),
      depotId: ig.vertexIds[depot]!,
      vertexCount: ig.n,
      edgeCount: ig.m,
      requiredEdgeCount: validation.stats.requiredEdgeCount,
      optionalEdgeCount: validation.stats.optionalEdgeCount,
    },
    degrees,
    oddVertexIds: odd.map((v) => ig.vertexIds[v]!),
    oddDistanceMatrix: k <= (options.distanceMatrixMaxOdd ?? 24) ? odd.map((_, i) => odd.map((__, j) => fromScaled(dist(i, j)))) : null,
    matching: {
      pairs,
      cost: fromScaled(matchingCost),
      optimalPairingCount,
      dualCertificateVerified: certificateVerified,
      crossCheckCost: crossCheckCost === null ? null : fromScaled(crossCheckCost),
    },
    augmentation: {
      addedCopies: Object.fromEntries([...addedCopies.entries()].sort((a, b) => a[0] - b[0]).map(([e, c]) => [ig.edgeIds[e]!, c])),
      addedDistance: fromScaled(addedScaled),
      allDegreesEven,
    },
    route: {
      steps,
      totalDistance: fromScaled(totalScaled),
      requiredDistance: fromScaled(requiredScaled),
      repeatedDistance: fromScaled(addedScaled),
      repeatedRequiredTraversals,
      deadheadTraversals,
      traversalCounts,
    },
    baselines,
    checks,
    warnings: validation.issues.filter((i) => i.severity !== 'error'),
    timingsMs: {
      validate: r3(tValidate - t0),
      shortestPaths: r3(tPaths - tValidate),
      matching: r3(tMatch - tPaths),
      euler: r3(tEuler - tMatch),
      verify: r3(tVerify - tEuler),
      total: r3(now() - t0),
    },
  };
  return record;
}
