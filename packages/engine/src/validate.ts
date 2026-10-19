import type { ConnectorSuggestion, Graph, GraphStats, Issue, Limits, ValidationReport } from './types.js';
import { MAX_WEIGHT, fromScaled } from './units.js';
import { indexGraph, edgeComponents, UnionFind, type IndexedGraph } from './graph.js';
import { dijkstra, reconstructPath } from './dijkstra.js';

/**
 * Default workload limits. These were chosen from the measured benchmarks in
 * BENCHMARKS (see TEST_PLAN.md / packages/engine/bench). The binding limit in
 * practice is the number of odd-degree vertices, because exact minimum-weight
 * perfect matching is O(k^3).
 */
export const DEFAULT_LIMITS: Limits = {
  maxVertices: 20_000,
  maxEdges: 40_000,
  maxOddVertices: 600,
};

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const COORD_LIMIT = 1e9;

/** `directed` is the legacy spelling of `oneway`. */
export function isOneway(e: { oneway?: boolean; directed?: boolean }): boolean {
  return e.oneway === true || e.directed === true;
}

/**
 * How validation treats one-way streets:
 * - 'reject'   (undirected solver default): one-way streets are an error, because the undirected solver cannot respect them;
 * - 'ignore'   (undirected solver, explicit relaxation): a warning; every street is treated as two-way;
 * - 'directed' (directed solver): informational only.
 */
export type OnewayPolicy = 'reject' | 'ignore' | 'directed';

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function emptyStats(): GraphStats {
  return {
    vertexCount: 0,
    edgeCount: 0,
    requiredEdgeCount: 0,
    optionalEdgeCount: 0,
    requiredWeight: 0,
    totalWeight: 0,
    selfLoopCount: 0,
    parallelEdgeCount: 0,
    zeroWeightEdgeCount: 0,
    isolatedVertexCount: 0,
    requiredComponentCount: 0,
  };
}

/**
 * Validate a graph for the undirected (rural) Chinese Postman model.
 * Structural problems are reported first; if any exist, topology checks are skipped.
 */
export function validateGraph(graph: Graph, opts: { depotId?: string | null; limits?: Partial<Limits>; onewayPolicy?: OnewayPolicy } = {}): ValidationReport {
  const onewayPolicy = opts.onewayPolicy ?? 'reject';
  const limits: Limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const issues: Issue[] = [];
  const stats = emptyStats();
  const vertices = Array.isArray(graph?.vertices) ? graph.vertices : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  stats.vertexCount = vertices.length;
  stats.edgeCount = edges.length;

  if (vertices.length === 0) {
    issues.push({ code: 'EMPTY_GRAPH', severity: 'error', message: 'The network has no intersections. Add vertices or load an example.' });
    return { ok: false, issues, stats, requiredComponents: [] };
  }
  if (vertices.length > limits.maxVertices || edges.length > limits.maxEdges) {
    issues.push({
      code: 'LIMIT_EXCEEDED',
      severity: 'error',
      message: `This network has ${vertices.length} vertices and ${edges.length} edges; the supported maximum is ${limits.maxVertices} vertices and ${limits.maxEdges} edges.`,
    });
    return { ok: false, issues, stats, requiredComponents: [] };
  }

  // --- Vertices ---------------------------------------------------------
  const seenV = new Set<string>();
  for (const v of vertices) {
    if (typeof v?.id !== 'string' || !ID_PATTERN.test(v.id)) {
      issues.push({ code: 'INVALID_ID', severity: 'error', message: `Vertex id ${JSON.stringify(v?.id)} is invalid (use 1–64 letters, digits, "_", "-", ".", ":").` });
      continue;
    }
    if (seenV.has(v.id)) {
      issues.push({ code: 'DUPLICATE_VERTEX_ID', severity: 'error', message: `Vertex id "${v.id}" is used more than once.`, vertexIds: [v.id] });
    }
    seenV.add(v.id);
    if (!isFiniteNumber(v.x) || !isFiniteNumber(v.y) || Math.abs(v.x) > COORD_LIMIT || Math.abs(v.y) > COORD_LIMIT) {
      issues.push({ code: 'INVALID_COORDINATE', severity: 'error', message: `Vertex "${v.id}" has invalid coordinates.`, vertexIds: [v.id] });
    }
  }

  // --- Edges ------------------------------------------------------------
  const seenE = new Set<string>();
  for (const e of edges) {
    if (typeof e?.id !== 'string' || !ID_PATTERN.test(e.id)) {
      issues.push({ code: 'INVALID_ID', severity: 'error', message: `Edge id ${JSON.stringify(e?.id)} is invalid (use 1–64 letters, digits, "_", "-", ".", ":").` });
      continue;
    }
    if (seenE.has(e.id)) {
      issues.push({ code: 'DUPLICATE_EDGE_ID', severity: 'error', message: `Edge id "${e.id}" is used more than once.`, edgeIds: [e.id] });
    }
    seenE.add(e.id);
    if (typeof e.u !== 'string' || typeof e.v !== 'string' || !seenV.has(e.u) || !seenV.has(e.v)) {
      issues.push({ code: 'MISSING_ENDPOINT', severity: 'error', message: `Edge "${e.id}" refers to a vertex that does not exist.`, edgeIds: [e.id] });
    }
    if (!isFiniteNumber(e.weight) || e.weight < 0 || e.weight > MAX_WEIGHT) {
      issues.push({
        code: 'INVALID_WEIGHT',
        severity: 'error',
        message: `Edge "${e.id}" has weight ${JSON.stringify(e.weight)}; weights must be finite numbers between 0 and ${MAX_WEIGHT}.`,
        edgeIds: [e.id],
      });
    }
    if (typeof e.required !== 'boolean') {
      issues.push({ code: 'INVALID_FIELD', severity: 'error', message: `Edge "${e.id}" must declare required: true or false.`, edgeIds: [e.id] });
    }
    if (e.reverseWeight !== undefined && (!isFiniteNumber(e.reverseWeight) || e.reverseWeight < 0 || e.reverseWeight > MAX_WEIGHT)) {
      issues.push({
        code: 'INVALID_WEIGHT',
        severity: 'error',
        message: `Edge "${e.id}" has reverse weight ${JSON.stringify(e.reverseWeight)}; weights must be finite numbers between 0 and ${MAX_WEIGHT}.`,
        edgeIds: [e.id],
      });
    }
    if (e.shape !== undefined) {
      const ok = Array.isArray(e.shape) && e.shape.length <= 2000 && e.shape.every((p) => Array.isArray(p) && p.length === 2 && isFiniteNumber(p[0]) && isFiniteNumber(p[1]));
      if (!ok) issues.push({ code: 'INVALID_COORDINATE', severity: 'error', message: `Edge "${e.id}" has an invalid shape polyline.`, edgeIds: [e.id] });
    }
  }

  const depotId = opts.depotId ?? graph.depotId ?? null;
  if (issues.some((i) => i.severity === 'error')) {
    return { ok: false, issues, stats, requiredComponents: [] };
  }

  // --- Topology ---------------------------------------------------------
  const ig = indexGraph(graph);
  const pairCount = new Map<string, number>();
  const degreeAll = new Int32Array(ig.n);
  for (let k = 0; k < ig.m; k++) {
    const u = ig.eu[k]!;
    const v = ig.ev[k]!;
    const w = fromScaled(ig.ew[k]!);
    stats.totalWeight += w;
    if (ig.required[k]) {
      stats.requiredEdgeCount++;
      stats.requiredWeight += w;
    } else stats.optionalEdgeCount++;
    if (u === v) stats.selfLoopCount++;
    if (ig.ew[k] === 0) stats.zeroWeightEdgeCount++;
    degreeAll[u] = degreeAll[u]! + 1;
    degreeAll[v] = degreeAll[v]! + 1;
    const key = u < v ? `${u}|${v}` : `${v}|${u}`;
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
  }
  stats.requiredWeight = round3(stats.requiredWeight);
  stats.totalWeight = round3(stats.totalWeight);
  for (const c of pairCount.values()) if (c > 1) stats.parallelEdgeCount += c - 1;

  if (stats.selfLoopCount > 0) {
    issues.push({ code: 'SELF_LOOP', severity: 'info', message: `${stats.selfLoopCount} self-loop(s) present. Supported: a loop adds 2 to its vertex's degree and is traversed as its own street.`, edgeIds: graph.edges.filter((e) => e.u === e.v).map((e) => e.id) });
  }
  if (stats.parallelEdgeCount > 0) {
    issues.push({ code: 'PARALLEL_EDGES', severity: 'info', message: `${stats.parallelEdgeCount} parallel edge(s) present. Supported: each parallel segment is a distinct street.` });
  }
  if (stats.zeroWeightEdgeCount > 0) {
    issues.push({ code: 'ZERO_WEIGHT', severity: 'info', message: `${stats.zeroWeightEdgeCount} zero-weight edge(s) present. Supported: they cost nothing to traverse.`, edgeIds: graph.edges.filter((e) => e.weight === 0).map((e) => e.id) });
  }
  const onewayIds = graph.edges.filter(isOneway).map((e) => e.id);
  if (onewayIds.length > 0) {
    if (onewayPolicy === 'reject') {
      issues.push({
        code: 'ONEWAY_REQUIRES_DIRECTED',
        severity: 'error',
        message: `${onewayIds.length} street(s) are one-way. The undirected solver cannot respect one-way restrictions, so it does not accept this network. Use Directed mode (minimum-cost-flow solver), or explicitly treat every street as two-way.`,
        edgeIds: onewayIds,
      });
    } else if (onewayPolicy === 'ignore') {
      issues.push({
        code: 'ONEWAY_IGNORED',
        severity: 'warning',
        message: `${onewayIds.length} one-way street(s) are being treated as two-way (relaxation requested). The resulting route may drive them against the permitted direction; it is not a legal route for the real network.`,
        edgeIds: onewayIds,
      });
    } else {
      issues.push({ code: 'ONEWAY_PRESENT', severity: 'info', message: `${onewayIds.length} one-way street(s): each may only be driven in its permitted direction.`, edgeIds: onewayIds });
    }
  }
  const asymmetric = graph.edges.filter((e) => e.reverseWeight !== undefined && e.reverseWeight !== e.weight && !isOneway(e)).map((e) => e.id);
  if (asymmetric.length > 0 && onewayPolicy !== 'directed') {
    issues.push({
      code: 'ASYMMETRIC_COST_IGNORED',
      severity: 'info',
      message: `${asymmetric.length} street(s) have a different cost in the reverse direction. The undirected solver uses the forward weight for both directions; Directed mode uses both costs.`,
      edgeIds: asymmetric,
    });
  }

  const isolated: string[] = [];
  for (let v = 0; v < ig.n; v++) if (degreeAll[v] === 0) isolated.push(ig.vertexIds[v]!);
  stats.isolatedVertexCount = isolated.length;
  if (isolated.length > 0) {
    issues.push({ code: 'ISOLATED_VERTEX', severity: 'warning', message: `${isolated.length} intersection(s) have no streets and will be ignored.`, vertexIds: isolated });
  }

  if (stats.requiredEdgeCount === 0) {
    issues.push({ code: 'NO_REQUIRED_EDGES', severity: 'error', message: 'No street is marked as required. Mark at least one street that the route must service.' });
    return { ok: false, issues, stats, requiredComponents: [] };
  }

  const comps = edgeComponents(ig, (k) => ig.required[k] === 1);
  stats.requiredComponentCount = comps.length;
  const requiredComponents = comps.map((c) => c.map((v) => ig.vertexIds[v]!));
  let connectorSuggestion: ConnectorSuggestion | undefined;

  if (comps.length > 1) {
    const ufAll = new UnionFind(ig.n);
    for (let k = 0; k < ig.m; k++) ufAll.union(ig.eu[k]!, ig.ev[k]!);
    const roots = new Set(comps.map((c) => ufAll.find(c[0]!)));
    if (roots.size > 1) {
      issues.push({
        code: 'REQUIRED_UNREACHABLE',
        severity: 'error',
        message: `The required streets lie in ${roots.size} parts of the network that no street connects. No single closed route can service all of them; split them into separate scenarios or add the missing connecting streets.`,
        vertexIds: comps.flatMap((c) => c.map((v) => ig.vertexIds[v]!)),
      });
    } else {
      connectorSuggestion = suggestConnectors(ig, comps);
      issues.push({
        code: 'REQUIRED_DISCONNECTED',
        severity: 'error',
        message: `The required streets form ${comps.length} separate groups. Covering separated groups optimally is the Rural Postman Problem, which is NP-hard; SWEEP solves it exactly only when the required streets are connected. Mark connecting streets as required (a suggestion is available) to continue.`,
        vertexIds: comps.flatMap((c) => c.map((v) => ig.vertexIds[v]!)),
        edgeIds: connectorSuggestion.edgeIds,
      });
    }
  }

  if (depotId != null) {
    const d = ig.vertexIndex.get(depotId);
    if (d === undefined) {
      issues.push({ code: 'DEPOT_UNKNOWN', severity: 'error', message: `The chosen start vertex "${depotId}" does not exist.`, vertexIds: [depotId] });
    } else if (!ig.adj[d]!.some((k) => ig.required[k] === 1)) {
      issues.push({
        code: 'DEPOT_NOT_ON_REQUIRED',
        severity: 'error',
        message: `The start vertex "${depotId}" is not on a required street. Choose a start on a required street (or mark a street at the depot as required).`,
        vertexIds: [depotId],
      });
    }
  }

  const ok = !issues.some((i) => i.severity === 'error');
  return { ok, issues, stats, requiredComponents, ...(connectorSuggestion ? { connectorSuggestion } : {}) };
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Suggest optional edges that connect all required components: a minimum
 * spanning tree over components, where the cost between two components is
 * their shortest-path distance. This is a heuristic for choosing *which*
 * streets to add; it does not solve the (NP-hard) Rural Postman Problem.
 */
function suggestConnectors(ig: IndexedGraph, comps: number[][]): ConnectorSuggestion {
  const compOf = new Int32Array(ig.n).fill(-1);
  comps.forEach((c, i) => c.forEach((v) => (compOf[v] = i)));
  const candidates: { a: number; b: number; d: number; target: number; tree: ReturnType<typeof dijkstra> }[] = [];
  comps.forEach((c, i) => {
    const tree = dijkstra(ig, c);
    const best = new Map<number, number>();
    for (let v = 0; v < ig.n; v++) {
      const j = compOf[v]!;
      if (j < 0 || j === i) continue;
      const d = tree.dist[v]!;
      if (!Number.isFinite(d)) continue;
      const cur = best.get(j);
      if (cur === undefined || d < tree.dist[cur]!) best.set(j, v);
    }
    for (const [j, v] of best) if (i < j) candidates.push({ a: i, b: j, d: tree.dist[v]!, target: v, tree });
  });
  candidates.sort((x, y) => x.d - y.d || x.a - y.a || x.b - y.b);
  const uf = new UnionFind(comps.length);
  const chosen = new Set<number>();
  for (const c of candidates) {
    if (!uf.union(c.a, c.b)) continue;
    const path = reconstructPath(ig, c.tree, c.target);
    for (const k of path.edges) if (!ig.required[k]) chosen.add(k);
  }
  const edgeIds = [...chosen].sort((a, b) => a - b).map((k) => ig.edgeIds[k]!);
  const weight = round3([...chosen].reduce((s, k) => s + fromScaled(ig.ew[k]!), 0));
  return {
    edgeIds,
    weight,
    note: 'Connectors are chosen by a minimum spanning tree over shortest paths between groups. After you mark them as required, SWEEP computes the exact optimal route for the enlarged set of required streets; the choice of connectors itself is a heuristic and is not guaranteed optimal for the original Rural Postman instance.',
  };
}
