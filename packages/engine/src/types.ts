/**
 * Core data model for SWEEP.
 *
 * Semantics (see MATHEMATICAL_SPEC.md):
 * - Graphs are UNDIRECTED, WEIGHTED MULTIGRAPHS.
 * - Parallel edges (two distinct street segments joining the same pair of
 *   intersections) are supported and treated as distinct edges.
 * - Self-loops (a street that leaves and returns to the same intersection)
 *   are supported; a loop contributes 2 to the degree of its vertex.
 * - Weights are finite, non-negative and at most MAX_WEIGHT. Internally they
 *   are converted to integer milli-units so that all sums, comparisons and
 *   optimality checks are exact.
 * - Directed edges are not supported in this version and are rejected.
 */

export type Point = [number, number];

export interface Vertex {
  id: string;
  /** Planar coordinate used for drawing (metres in a local projection, or abstract units). */
  x: number;
  y: number;
  label?: string;
}

export interface Edge {
  id: string;
  u: string;
  v: string;
  /** Traversal cost (typically metres). Must be finite and >= 0. */
  weight: number;
  /** Required service edge: must be traversed at least once. */
  required: boolean;
  name?: string;
  /** Optional interior polyline points (excluding the endpoints) for curved streets. */
  shape?: Point[];
  /** Directed edges are rejected by validation in this version. */
  directed?: boolean;
}

export interface Graph {
  format?: 'sweep.graph';
  version?: 1;
  name?: string;
  description?: string;
  units?: string;
  vertices: Vertex[];
  edges: Edge[];
  /** Vertex where the closed route starts and ends. Must touch a required edge. */
  depotId?: string | null;
}

export type Severity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'EMPTY_GRAPH'
  | 'NO_REQUIRED_EDGES'
  | 'INVALID_ID'
  | 'DUPLICATE_VERTEX_ID'
  | 'DUPLICATE_EDGE_ID'
  | 'INVALID_COORDINATE'
  | 'MISSING_ENDPOINT'
  | 'INVALID_WEIGHT'
  | 'INVALID_FIELD'
  | 'DIRECTED_UNSUPPORTED'
  | 'SELF_LOOP'
  | 'PARALLEL_EDGES'
  | 'ZERO_WEIGHT'
  | 'ISOLATED_VERTEX'
  | 'REQUIRED_DISCONNECTED'
  | 'REQUIRED_UNREACHABLE'
  | 'DEPOT_UNKNOWN'
  | 'DEPOT_NOT_ON_REQUIRED'
  | 'LIMIT_EXCEEDED';

export interface Issue {
  code: IssueCode;
  severity: Severity;
  message: string;
  vertexIds?: string[];
  edgeIds?: string[];
}

export interface ConnectorSuggestion {
  /** Optional edges whose promotion to "required" would connect all required components. */
  edgeIds: string[];
  /** Total weight of the suggested connectors (display units). */
  weight: number;
  /** Honest description of what the suggestion does and does not guarantee. */
  note: string;
}

export interface GraphStats {
  vertexCount: number;
  edgeCount: number;
  requiredEdgeCount: number;
  optionalEdgeCount: number;
  requiredWeight: number;
  totalWeight: number;
  selfLoopCount: number;
  parallelEdgeCount: number;
  zeroWeightEdgeCount: number;
  isolatedVertexCount: number;
  requiredComponentCount: number;
}

export interface ValidationReport {
  ok: boolean;
  issues: Issue[];
  stats: GraphStats;
  /** Vertex ids grouped by connected component of the required-edge subgraph. */
  requiredComponents: string[][];
  connectorSuggestion?: ConnectorSuggestion;
}

export interface Limits {
  maxVertices: number;
  maxEdges: number;
  maxOddVertices: number;
}

export interface SolveOptions {
  depotId?: string | null;
  limits?: Partial<Limits>;
  /** Run the O(2^k k) subset-DP matching cross-check when k <= this value (default 16). */
  crossCheckMaxOdd?: number;
  /** Include the full odd-vertex distance matrix in the record when k <= this value (default 24). */
  distanceMatrixMaxOdd?: number;
}

export type TraversalKind =
  /** First traversal of a required edge (service). */
  | 'service'
  /** An additional traversal of a required edge. */
  | 'repeat'
  /** Traversal of an optional (non-required) edge, used only to reposition. */
  | 'deadhead';

export interface RouteStep {
  index: number;
  edgeId: string;
  from: string;
  to: string;
  weight: number;
  kind: TraversalKind;
  /** Distance travelled up to and including this step. */
  cumulative: number;
}

export interface MatchedPair {
  a: string;
  b: string;
  /** Shortest-path distance between a and b in the full graph. */
  distance: number;
  /** Vertex sequence of the duplicated shortest path, from a to b. */
  pathVertices: string[];
  /** Edge sequence of the duplicated shortest path, from a to b. */
  pathEdgeIds: string[];
}

export interface CheckResult {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface Baseline {
  id: 'lower-bound' | 'greedy-pairing' | 'double-every-street';
  label: string;
  /** Total cost, or null if not applicable. */
  total: number | null;
  /** Whether this number is the cost of an actual valid closed route. */
  isValidRoute: boolean;
  description: string;
}

export interface DegreeInfo {
  vertexId: string;
  /** Degree in the required-edge subgraph (a loop counts 2). */
  requiredDegree: number;
  odd: boolean;
}

export interface OptimizationRecord {
  ok: true;
  engine: { name: 'sweep-engine'; version: string };
  algorithm: {
    problem: 'undirected-chinese-postman' | 'undirected-rural-postman-connected-required';
    shortestPaths: 'dijkstra-binary-heap';
    matching: 'none' | 'edmonds-blossom';
    matchingCrossCheck: 'subset-dp' | 'skipped';
    euler: 'hierholzer';
    optimal: boolean;
    optimalityBasis: string;
  };
  input: {
    graphHash: string;
    name?: string;
    depotId: string;
    vertexCount: number;
    edgeCount: number;
    requiredEdgeCount: number;
    optionalEdgeCount: number;
  };
  degrees: DegreeInfo[];
  oddVertexIds: string[];
  /** Full shortest-path distance matrix between odd vertices (omitted for large k). */
  oddDistanceMatrix: number[][] | null;
  matching: {
    pairs: MatchedPair[];
    cost: number;
    /** Number of distinct optimal pairings (computed when k <= cross-check limit). */
    optimalPairingCount: number | null;
    dualCertificateVerified: boolean;
    crossCheckCost: number | null;
  };
  augmentation: {
    /** Number of added edge copies per edge id (only edges with additions are listed). */
    addedCopies: Record<string, number>;
    addedDistance: number;
    allDegreesEven: boolean;
  };
  route: {
    steps: RouteStep[];
    totalDistance: number;
    requiredDistance: number;
    repeatedDistance: number;
    repeatedRequiredTraversals: number;
    deadheadTraversals: number;
    /** Traversal count per edge id (0 if an edge is never used). */
    traversalCounts: Record<string, number>;
  };
  baselines: Baseline[];
  checks: CheckResult[];
  warnings: Issue[];
  timingsMs: { validate: number; shortestPaths: number; matching: number; euler: number; verify: number; total: number };
}

export interface OptimizationFailure {
  ok: false;
  engine: { name: 'sweep-engine'; version: string };
  validation: ValidationReport;
}

export type OptimizationResult = OptimizationRecord | OptimizationFailure;
