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
 * - One-way streets: an edge with `oneway: true` may only be driven from u to v.
 *   The undirected solver (solve.ts) cannot respect that and refuses such
 *   networks unless asked to treat every street as two-way; the directed
 *   solver (directed.ts) models one-way and two-way streets as arcs.
 */

export type Point = [number, number];

export interface Vertex {
  id: string;
  /** Planar coordinate used for drawing (metres in a local projection, or abstract units). */
  x: number;
  y: number;
  label?: string;
  /** Geographic position [longitude, latitude] (WGS84) when the network came from map data. */
  geo?: Point;
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
  /** One-way street: may only be driven from u to v (see the module note above). */
  oneway?: boolean;
  /**
   * Cost of driving a two-way street from v to u, when it differs from `weight`
   * (asymmetric travel costs, for example uphill). Used only by the directed solver.
   */
  reverseWeight?: number;
  /** Legacy alias of `oneway` accepted on input; coerceGraph converts it. */
  directed?: boolean;
  /** Source reference, for example "osm:way/123456" for map data. */
  sourceRef?: string;
  /** Road class from the source data (for example OSM highway=residential). */
  roadClass?: string;
}

export type DataSourceKind = 'example' | 'bundled-sample' | 'imported-file' | 'live-acquisition' | 'user';

/** Where a network came from. Shown in the interface and kept in exports. */
export interface DataProvenance {
  kind: DataSourceKind;
  /** Human-readable source name, for example "OpenStreetMap via Overpass API (overpass.osm.ch)". */
  provider?: string;
  /** Endpoint actually used for a live acquisition. */
  endpoint?: string;
  /** ISO time of retrieval (live acquisition) or of the original download (bundled sample). */
  retrievedAt?: string;
  /** Coverage extent [south, west, north, east] in degrees. */
  bbox?: [number, number, number, number];
  attribution?: string;
  license?: string;
  /** Road classes included (OSM highway values). */
  roadClasses?: string[];
  /** Processing notes and warnings from the conversion. */
  notes?: string[];
  /** True when the dataset was served from the local acquisition cache. */
  cached?: boolean;
}

export type RoutingMode = 'undirected' | 'directed';
/**
 * How a two-way street is serviced in directed mode:
 * - 'both':   each direction is a separate required arc (both kerbs, typical for street sweeping);
 * - 'either': one traversal in either direction suffices (the mixed postman problem).
 */
export type TwoWayService = 'both' | 'either';
export type FleetObjective = 'balance' | 'total';

/** Routing configuration stored with a scenario. All fields optional; defaults in DEFAULT_ROUTING. */
export interface RoutingSettings {
  mode?: RoutingMode;
  twoWay?: TwoWayService;
  /** In undirected mode, treat one-way streets as two-way (a relaxation; the route may break one-way rules). */
  ignoreOneway?: boolean;
  vehicles?: number;
  objective?: FleetObjective;
  /** Optional per-vehicle route length limit (same units as weights). */
  maxRouteLength?: number | null;
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
  source?: DataProvenance;
  routing?: RoutingSettings;
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
  | 'LIMIT_EXCEEDED'
  | 'ONEWAY_REQUIRES_DIRECTED'
  | 'ONEWAY_IGNORED'
  | 'ONEWAY_PRESENT'
  | 'ASYMMETRIC_COST_IGNORED'
  | 'DIRECTED_INFEASIBLE'
  | 'MIXED_TOO_LARGE'
  | 'FLEET_INVALID'
  | 'FLEET_IDLE'
  | 'FLEET_LIMIT_INFEASIBLE'
  | 'FLEET_LIMIT_UNMET';

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
  /** Treat one-way streets as two-way (an explicit relaxation; otherwise they are rejected). */
  ignoreOneway?: boolean;
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
  id: 'lower-bound' | 'greedy-pairing' | 'double-every-street' | 'greedy-balancing' | 'return-after-each';
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
  mode: 'undirected';
  engine: { name: 'sweep-engine'; version: string };
  algorithm: {
    problem: 'undirected-chinese-postman' | 'undirected-rural-postman-connected-required';
    /** 'oneway-ignored': the network has one-way streets that this run treated as two-way (a relaxation). */
    directionPolicy: 'two-way' | 'oneway-ignored';
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
    /** Steps that drive a one-way street against its direction (only possible when one-way streets were ignored). */
    wrongWayTraversals: number;
  };
  baselines: Baseline[];
  checks: CheckResult[];
  warnings: Issue[];
  timingsMs: { validate: number; shortestPaths: number; matching: number; euler: number; verify: number; total: number };
}

/** One permitted direction of travel along a street. */
export interface ArcInfo {
  /** Arc id: `<edgeId>>` for u→v, `<edgeId><` for v→u. */
  id: string;
  edgeId: string;
  from: string;
  to: string;
  weight: number;
  /** True when this arc carries a service obligation (for 'either' streets: the orientation chosen by the solver). */
  required: boolean;
}

export interface ArcBalance {
  vertexId: string;
  /** Required arcs entering / leaving the vertex. */
  inRequired: number;
  outRequired: number;
  /** in − out. Positive: the route must leave this vertex `delta` extra times; negative: arrive extra times. */
  delta: number;
}

export interface FlowPath {
  from: string;
  to: string;
  /** Number of copies of this path added to the route. */
  units: number;
  /** Length of one copy (shortest legal path). */
  distance: number;
  pathVertices: string[];
  pathEdgeIds: string[];
  pathArcIds: string[];
}

export interface DirectedOptimizationRecord {
  ok: true;
  mode: 'directed';
  engine: { name: 'sweep-engine'; version: string };
  algorithm: {
    problem: 'directed-chinese-postman' | 'directed-rural-postman-connected-required' | 'mixed-chinese-postman-exact-enumeration';
    twoWay: TwoWayService;
    shortestPaths: 'dijkstra-reduced-costs';
    balancing: 'none' | 'min-cost-flow-ssp';
    /** For 'either' service: number of two-way required streets and orientations evaluated exactly. */
    orientationSearch: { twoWayRequired: number; orientationsEvaluated: number } | null;
    euler: 'hierholzer-directed';
    optimal: boolean;
    optimalityBasis: string;
  };
  input: {
    graphHash: string;
    name?: string;
    depotId: string;
    vertexCount: number;
    edgeCount: number;
    arcCount: number;
    requiredArcCount: number;
    onewayEdgeCount: number;
    requiredEdgeCount: number;
    optionalEdgeCount: number;
  };
  arcs: ArcInfo[];
  balance: ArcBalance[];
  imbalancedVertexIds: string[];
  flow: {
    paths: FlowPath[];
    cost: number;
    totalUnits: number;
    /** LP duality: node potentials give non-negative reduced costs and zero reduced cost on every arc carrying flow. */
    dualCertificateVerified: boolean;
    /** Optimum found by an independent state-space search over (vertex, covered set), for small instances. */
    crossCheckCost: number | null;
  };
  augmentation: {
    /** Added copies per arc id. */
    addedCopies: Record<string, number>;
    /** Added copies per street (edge) id, summed over both directions. */
    addedEdgeCopies: Record<string, number>;
    addedDistance: number;
    balanced: boolean;
  };
  route: OptimizationRecord['route'];
  baselines: Baseline[];
  checks: CheckResult[];
  warnings: Issue[];
  timingsMs: { validate: number; flow: number; euler: number; verify: number; total: number };
}

export type SingleRouteRecord = OptimizationRecord | DirectedOptimizationRecord;
export type DirectedResult = DirectedOptimizationRecord | OptimizationFailure;

export interface VehicleRoute {
  vehicle: number;
  steps: RouteStep[];
  distance: number;
  /** Distance of the traversals that fulfil a service obligation first (fleet-wide). */
  serviceDistance: number;
  /** Driving from the depot to the first assigned street and back from the last one. */
  approachDistance: number;
  returnDistance: number;
  /** Index range [start, end) of the single-vehicle tour that this vehicle covers. */
  tourRange: [number, number];
  servicedEdgeIds: string[];
  checks: CheckResult[];
}

export interface FleetRecord {
  ok: true;
  mode: 'fleet';
  engine: { name: 'sweep-engine'; version: string };
  vehicles: number;
  activeVehicles: number;
  objective: FleetObjective;
  maxRouteLength: number | null;
  routingMode: RoutingMode;
  depotId: string;
  algorithm: {
    method: 'tour-splitting';
    split: 'fhk-threshold' | 'optimal-split-dp';
    /** Proven worst-case factor for the longest route versus the optimum, or null when none is proven. */
    ratioBound: number | null;
    guarantee: string;
  };
  /** The certified single-vehicle route that was split. */
  base: SingleRouteRecord;
  routes: VehicleRoute[];
  makespan: number;
  totalDistance: number;
  singleVehicleDistance: number;
  lowerBound: {
    value: number;
    perVehicleShare: number;
    farthestStreet: { edgeId: string; roundTrip: number } | null;
  };
  /** makespan / lower bound (≥ 1). The true optimum lies between the lower bound and the makespan. */
  gapRatio: number;
  coverage: { obligations: number; covered: number; missingEdgeIds: string[]; sharedEdgeIds: string[] };
  checks: CheckResult[];
  warnings: Issue[];
  timingsMs: { base: number; split: number; verify: number; total: number };
}

export type FleetResult = FleetRecord | OptimizationFailure;

export interface OptimizationFailure {
  ok: false;
  engine: { name: 'sweep-engine'; version: string };
  validation: ValidationReport;
}

export type OptimizationResult = OptimizationRecord | OptimizationFailure;
