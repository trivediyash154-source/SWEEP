# SWEEP: Mathematical Specification

This document describes exactly what the engine in `packages/engine` computes. Every statement here is implemented and covered by tests (see [TEST_PLAN.md](TEST_PLAN.md)).

## 1. Graph model

A network is a **weighted multigraph** `G = (V, E, w)` whose streets may be two-way or one-way. Three solvers share it: the exact undirected solver (§2–§8), the exact directed/mixed solver (§9) and the fleet planner (§10).

| Aspect | Semantics |
|---|---|
| Vertices | Intersections. Each has a unique id (`[A-Za-z0-9_.:-]{1,64}`) and planar drawing coordinates `(x, y)`, with `x` pointing east and `y` pointing south. |
| Edges | Street segments. Each has a unique id, endpoints `u` and `v`, a weight `w ≥ 0`, a `required` flag, an optional name, and an optional interior polyline `shape` used only for drawing. |
| Parallel edges | **Supported.** Two distinct streets joining the same pair of intersections are separate edges. |
| Self-loops | **Supported.** A loop contributes **2** to the degree of its vertex and is traversed as its own street. |
| Zero weights | **Supported.** For example, a plaza modelled as two nodes joined by a 0 m link. |
| Weights | Finite, `0 ≤ w ≤ 1,000,000`. Stored internally as integer milli-units (`round(1000·w)`). |
| One-way streets | `oneway: true` means the street may be driven only from `u` to `v` (`directed: true` is accepted as a legacy spelling). The **undirected solver refuses** such networks (`ONEWAY_REQUIRES_DIRECTED`) unless the caller explicitly asks for the two-way relaxation (`ignoreOneway`), in which case the record is labelled `directionPolicy: 'oneway-ignored'`, counts `wrongWayTraversals`, and adds a `direction` check that fails if any one-way street is driven backwards. The directed solver (§9) respects them exactly. |
| Reverse costs | `reverseWeight` is the cost of driving a two-way street from `v` to `u` (asymmetric costs, for example uphill). Used only by the directed solver; the undirected solver reports `ASYMMETRIC_COST_IGNORED`. |
| Geography | Optional `geo: [lon, lat]` per vertex, `sourceRef`/`roadClass` per edge and `source` provenance per graph (kind, provider, endpoint, retrieval time, bounding box, attribution, licence, notes). |
| Isolated vertices | Allowed. They produce a warning and are ignored. |

**Exact arithmetic.** With at most 40,000 edges of at most 10⁹ milli-units each, every path length and route total is below 2⁵³. All additions and comparisons are therefore exact in IEEE-754 doubles, including tie detection between equally optimal pairings. Inside the matching algorithm, dual variables are multiples of ½ of integers, which is also exact.

## 2. Problem solved

Let `R ⊆ E` be the required edges, and let the start vertex `s` be incident to some required edge.

```
minimise  w(W)  over closed walks W from s
subject to   every e ∈ R is traversed by W at least once
```

* If `R = E`, this is the **Chinese Postman Problem** (studied by Meigu Guan in 1960).
* If `R ⊊ E` and the subgraph formed by `R` is **connected**, this is the Rural Postman Problem restricted to a connected required set. It is solved exactly by the same method, because optional edges can be used as shortcuts ("deadheading").
* If the required edges form **more than one connected component**, the general Rural Postman Problem is NP-hard. SWEEP **rejects** the input with the code `REQUIRED_DISCONNECTED` rather than return an unproven route (see §7).

The engine does not claim that every street can be covered exactly once. Repetition is required whenever the required subgraph has odd-degree vertices.

## 3. Algorithm (`solveChinesePostman`)

1. **Validate** structure, ids, endpoints, weights and limits, then the connectivity of `R` (union-find) and the start vertex.
2. **Degrees.** Compute `deg_R(v)`, the degree in `(V, R)`, where a loop counts 2. Let `T = { v : deg_R(v) odd }` and `k = |T|`. By the handshake lemma (`Σ deg_R(v) = 2|R|`), `k` is even.
3. **Shortest paths.** Run Dijkstra from every `t ∈ T` over **all** edges (required and optional), using a binary heap keyed by `(distance, vertex index)` so that ties are broken deterministically. Self-loops are skipped because they never shorten a path. This yields `d(a, b)` for all `a, b ∈ T` and the shortest-path trees.
4. **Exact minimum-weight perfect matching** on the complete graph `K_T` with costs `d(a, b)`.
   * Uses Edmonds' blossom algorithm (primal-dual, O(k³)), in a line-by-line TypeScript port of the public-domain reference implementation by J. van Rantwijk (after Galil, 1986), run with `maxCardinality = true` on weights `C − d(a, b)`, where `C = max d + 1`.
   * When `k ≤ 16`, an independent **subset dynamic program**, O(2ᵏ·k), recomputes the optimum and counts the number of distinct optimal pairings.
5. **Augmentation.** For each matched pair, duplicate the edges of its shortest path. Optional edges on these paths become deadhead traversals; required edges become repeat traversals. The result is checked: every vertex of the augmented multigraph has even degree.
6. **Euler circuit.** Run iterative Hierholzer from `s` on the augmented multigraph, scanning edges in index order so the result is deterministic. Its length must equal the number of augmented edges, which proves connectivity.
7. **Labelling.** The first traversal of a required edge is `service`, any later traversal is `repeat`, and a traversal of an optional edge is `deadhead`.
8. **Verification** (§5), then **baselines** (§6).

### Why it is optimal

For a connected required set `R`, every feasible closed walk uses each required edge once plus an edge multiset `X` that makes all degrees even: a `T`-join. A minimum-cost `T`-join in a graph with non-negative weights is the union of shortest paths of a minimum-weight perfect matching on `T` under shortest-path distances (Edmonds & Johnson, 1973). Since `R` is connected and every added path touches `R`, `R ∪ X` is connected and Eulerian, and Hierholzer's algorithm realises the walk. The minimum route length is therefore `w(R) + ν(T)`, where `ν(T)` is the minimum matching cost. The test suite checks this formula independently by exhaustive search (see TEST_PLAN.md).

### Complexity

| Step | Cost |
|---|---|
| Validation | O(\|V\| + \|E\|·α) |
| Dijkstra from k sources | O(k·(\|E\| + \|V\|)·log \|V\|) |
| Blossom matching on K_T | O(k³) time, O(k²) memory |
| Subset-DP cross-check (k ≤ 16) | O(2ᵏ·k) |
| Augmentation and Hierholzer | O(\|E\| + k·\|V\|) |
| Verification | O(route length) |

**Supported workload** (`DEFAULT_LIMITS`): 20,000 vertices, 40,000 edges and **600 odd vertices**. The odd-vertex limit comes from the measured matching cost: 458 odd vertices take about 0.7 s and 696 take about 2.3 s on the benchmark machine (TEST_PLAN.md §5). Inputs above the limit are rejected with `LIMIT_EXCEEDED` and an explanation. The server also runs every optimisation in a worker thread with a 20 s timeout.

## 4. Output record (`OptimizationRecord`)

| Section | Contents |
|---|---|
| `engine`, `algorithm` | Version; problem variant; methods used; `optimal` flag and `optimalityBasis` |
| `input` | `graphHash` (SHA-256 of a canonical JSON of vertices, edges, depot and engine version), counts, depot |
| `degrees`, `oddVertexIds` | Required degree per vertex; the odd set `T` |
| `oddDistanceMatrix` | `d(a, b)` for `k ≤ 24` (null otherwise) |
| `matching` | Pairs with distance, vertex path and edge path; cost; `optimalPairingCount` (k ≤ 16); `dualCertificateVerified`; `crossCheckCost` |
| `augmentation` | Added copies per edge; added distance; `allDegreesEven` |
| `route` | Ordered `steps` (edge, from, to, weight, kind, cumulative); totals; repeat and deadhead counts; traversal count per edge |
| `baselines` | §6 |
| `checks` | §5 |
| `timingsMs` | Measured phases. These are metadata only and never affect results. |

**Reproducibility.** The same input always produces the same route, step for step. This is tested by the `is deterministic` test and the "re-run equals stored run" API test.

## 5. Verification (every result)

`verifyRoute` re-derives each invariant from the raw graph and the ordered steps alone. It does not use solver internals.

| Check id | Condition |
|---|---|
| `continuity` | The first step starts at `s`; each step is a valid traversal of its edge (`{from, to} = {u, v}`); each step starts where the previous one ended |
| `closed` | The last step ends at `s` |
| `coverage` | Every required edge appears at least once |
| `weights` | Each step's weight equals its edge weight; cumulative distances equal running sums; the total equals the reported total (exact, in milli-units) |
| `classification` | `service`, `repeat` and `deadhead` labels are consistent |

The solver adds:

| Check id | Condition |
|---|---|
| `parity` | The augmented multigraph has all degrees even |
| `matching-perfect` | Every odd vertex is matched exactly once |
| `matching-cost` | Added distance equals the matching cost |
| `dual-certificate` | **LP-duality certificate.** Vertex and blossom duals are feasible (no negative reduced cost on any edge of `K_T`); matched edges have zero slack; unmatched vertices have zero dual; every blossom with a positive dual is full. These conditions prove that the matching is optimal. |
| `dp-cross-check` | For `k ≤ 16`, the subset DP gives the same cost |

`algorithm.optimal` is `true` only if **every** check passes.

## 6. Baselines (all real, all computed)

| Baseline | Definition | Valid route? |
|---|---|---|
| Lower bound | `w(R)` | Only when `k = 0` |
| Greedy pairing | The same pipeline, but odd vertices are paired by repeatedly taking the globally closest unpaired pair | Yes |
| Out-and-back on every street | Every required edge traversed twice (all degrees even, connected) | Yes; equals `2·w(R)` |

No baseline is fabricated. The UI states which baselines are bounds and which are routes.

## 7. Disconnected required streets

If `(V, R)` has several components, there are two cases:

* **Unreachable:** some components are not connected through any street. The code is `REQUIRED_UNREACHABLE`, and no closed route can exist.
* **Disconnected:** the components are connected only through optional streets. The code is `REQUIRED_DISCONNECTED`, and SWEEP offers a **connector suggestion**. It computes a minimum spanning tree over the required components, where the cost between two components is their multi-source shortest-path distance, and lists the optional edges on the chosen paths. After the user marks them required, the route is **optimal for the enlarged required set**. The choice of connectors is a heuristic and is stated as such in the UI.

## 8. GeoJSON conversion (`geojsonToGraph`)

1. Accepts a `FeatureCollection` or a `Feature` with `LineString` or `MultiLineString` geometry in WGS84 `[longitude, latitude]`. Other geometries are skipped and reported. The limits are 10,000 features and 50,000 coordinates.
2. Coordinates are snapped to 1e-7° (about 1 cm). Consecutive duplicates are dropped.
3. A coordinate becomes a **vertex** if it is a line endpoint or occurs at two or more places across all lines.
4. Lines are split at vertices. Each piece becomes one edge, and its interior points are kept as `shape`.
5. **Weight** is the geodesic length by haversine (R = 6,371,008.8 m), rounded to 0.1 m.
6. **Drawing coordinates** use a local equirectangular projection about the mean longitude and latitude, in metres.
7. The property `required: false` makes a street optional; the default is required. `name` is kept. `oneway` (`yes`/`true`/`1`, or `-1` for the reverse direction) marks a one-way street; the workspace then switches the scenario to directed routing.

Limitation: crossings that are not shared vertices in the source data (for example bridges, or data that is not noded) are not treated as intersections.

## 9. Directed and mixed networks (`solveDirectedPostman`, `directed.ts`)

A separate module; it never uses the undirected matching.

**Arcs.** Each street becomes its permitted directions: a one-way street gives the arc `u→v` (cost `w`); a two-way street gives `u→v` (cost `w`) and `v→u` (cost `reverseWeight ?? w`).

**Service rule** (`twoWay`):

* `'both'` — every direction of a required two-way street is a separate obligation (both kerbs, as in street sweeping); a required one-way street must be driven forwards once. This is the **directed Chinese Postman Problem** (or its rural version with a connected required set).
* `'either'` — a required two-way street must be driven once in either direction: the **mixed Chinese Postman Problem**, which is NP-hard.

**Feasibility.** With required arcs `R`, a closed legal walk from the depot that covers `R` exists iff every vertex touched by `R` lies in the depot's strongly connected component of the arc graph (reachable from the depot and able to reach it). Otherwise the solver returns `DIRECTED_INFEASIBLE` and names the streets that can be entered but not left (`noReturn`) or not reached (`unreachable`); `findUnserviceableStreets` exposes the same analysis, and the workspace offers to mark those streets optional. Disconnected required streets (the directed rural postman problem) are refused with `REQUIRED_DISCONNECTED`, as in §7.

**Method for a fixed `R`** (Edmonds & Johnson 1973, directed case):

1. Balance `b(v) = in_R(v) − out_R(v)`. A closed walk leaves every vertex as often as it enters it, so a vertex with `b(v) > 0` needs `b(v)` extra departures.
2. Solve the uncapacitated **minimum-cost flow** `min Σ c(a)·x(a)` subject to `out_x(v) − in_x(v) = b(v)`, `x ≥ 0` over all permitted arcs (`mincostflow.ts`: successive shortest paths with Dijkstra on reduced costs and node potentials; integer costs, so the flow is integral and exact).
3. Decompose the flow into supply→demand shortest legal paths (zero-cost cycles cancelled) and add one copy of each arc per unit.
4. `R` plus the flow is balanced, and weakly connected because `R` is and every path joins `R`; a balanced, weakly connected digraph is strongly connected and Eulerian. Hierholzer's algorithm (directed) produces the route.

Every feasible closed walk decomposes into `R` plus a flow satisfying the same balance constraints, so `c(R) + flow cost` is optimal.

**Mixed case.** For `'either'`, any optimal walk induces a service direction for each required two-way street, after which it is feasible for the directed problem with that orientation. The solver therefore enumerates all `2^t` orientations of the `t` required two-way streets, solves each by the flow method, and keeps the cheapest: an exact algorithm, offered for `t ≤ 12` (`MIXED_TOO_LARGE` above that; `'both'` has no such limit).

**Certificates and checks.** `verifyFlowOptimality` checks conservation, dual feasibility (every permitted arc has reduced cost `c(a) + π(tail) − π(head) ≥ 0`), complementary slackness (zero reduced cost on every arc carrying flow) and equal primal and dual objectives. `verifyDirectedRoute` independently checks continuity, permitted directions (`direction`), closure, coverage of every obligation, directional costs and labels. For instances with at most 12 obligations an **independent state-space search** (`stateSearch.ts`: Dijkstra over states `(vertex, set of fulfilled obligations)`, built from the raw graph) recomputes the optimum; the record's `state-search-cross-check` must agree.

**Baselines.** Lower bound (sum of required directions, or the cheaper direction for `'either'`); *greedy balancing* (each surplus vertex joined to its nearest deficit vertex greedily; a valid route); *return after every street* (drive each required direction and come straight back by the shortest legal path; a valid route).

**Tests.** Hand-verifiable networks: a directed Eulerian cycle; imbalanced vertices; a non-trivial augmentation that greedy balancing misses (24 vs 28); a one-way dead end (infeasible, no return) and an unreachable street; disconnected required streets; asymmetric costs (both and either); a network where the undirected optimum drives a one-way street backwards while the directed optimum does not; the mixed-size limit; determinism. Randomised: 700 random one-way networks per service rule against the state-space search (all agree; infeasibility detected exactly when the search finds no walk), and 400 random two-way graphs where `'either'` equals the undirected optimum.

**Independent oracle (Python, `oracle/run_oracle.py`).** It shares no code with the engine. On 1,401 directed and mixed networks (1,400 random, plus the real Zurich sample), it computes the optimum two ways:

* networkx `min_cost_flow` (network simplex, where SWEEP uses successive shortest paths) for every `'both'` instance;
* a plain Dijkstra over (vertex, serviced obligations) for every instance with ≤ 11 obligations, `'either'` included. This search relies on no postman theory.

It also re-walks each route: legal direction on every step, closed at the start, every obligation serviced, length equal to the reported total. Every SWEEP rejection is confirmed as genuinely infeasible, meaning no strongly connected covering walk exists, or as disconnected required streets. In the latest run, 490 instances were compared by flow and 681 by state search, and all agree.

## 10. Multiple vehicles (`solveFleet`, `fleet.ts`)

**Problem.** `k` vehicles (1–12) start and end at one shared depot; every service obligation must be fulfilled by at least one vehicle. Objectives:

* `'balance'` — minimise the **longest** route (makespan), total distance as tie-breaker (the min–max k-Chinese/rural postman problem; NP-hard for `k ≥ 2`).
* `'total'` — minimise **total** distance, optionally with a per-vehicle route-length limit.

Distinct depots per vehicle, capacities and time windows are not modelled.

**Method (route first, split second).** Solve the single-vehicle problem exactly (certified tour of length `L`, from §3 or §9), then split the tour into at most `k` consecutive pieces. Vehicle `j` drives a shortest legal path from the depot to its piece, the piece, and back. Pure deadhead runs at a cut may be dropped. The split is chosen by the Frederickson–Hecht–Kim threshold rule and, for tours up to 2,500 steps, improved by an exact dynamic programme over all splits of the tour (minimum makespan, then minimum total among those).

**Guarantee (undirected, `'balance'`).** Let `D = max` over required streets of `d(s,u) + w + d(v,s)`. Every route produced is at most `(L − D)/k + D`, and the optimum makespan is at least `max(L/k, D)` (any `k` depot routes joined at the depot form one covering walk, so `L ≤ k·OPT`; some vehicle must serve the farthest street). Hence the longest route is within **`2 − 1/k`** of optimal (Frederickson, Hecht & Kim 1978). The bound `(L − D)/k + D` is checked on every run (`fhk-bound`) and the record reports the lower bound and the gap `makespan / max(L/k, D)`.

**Directed fleets.** The same construction with directed distances; the proof uses symmetric distances, so **no ratio is claimed**: results are labelled heuristic and shown with their lower bound.

**`'total'` without a limit** is solved exactly by one vehicle (extra vehicles can never reduce total distance from a single depot), and the record says so. With a limit it is a heuristic: `FLEET_LIMIT_INFEASIBLE` when some street's round trip alone exceeds the limit (proven), `FLEET_LIMIT_UNMET` when no split of the tour fits (a feasible plan may still exist).

**Verification.** `verifyFleet` checks each route's legality, closure and distances, and that the routes together fulfil every obligation; service labels are checked fleet-wide.

**Tests.** One vehicle reproduces the single route exactly; 2, 3 and 5 vehicles cover everything with consistent per-vehicle costs and the proven bound; invalid, empty and excessive fleets; invalid depots and unreachable streets; the exact `'total'` case; route limits (met, provably infeasible, unmet); directed fleets obey one-way streets; determinism; and, on 120 tiny random graphs, the longest route lies between the brute-force min–max optimum for `k = 2` and 1.5 × that optimum.

## 11. OpenStreetMap conversion (`osmToGraph`, `osm.ts`)

Converts Overpass API JSON into a network: included road classes are whitelisted; a node becomes an intersection if it ends a way, is shared by ways or repeats within a way; ways are split there; lengths are haversine metres; vertices keep `geo`; edges keep `sourceRef` (`osm:way/<id>`) and `roadClass`. One-way follows OSM conventions (`oneway=yes|true|1`, `-1` reversed, roundabouts and motorways implied, `oneway=no` overrides). Missing nodes, zero-length pieces and duplicate segments are removed and counted; closed ways without junctions are split so no loops appear; only the largest connected component is kept by default (dropped parts are reported). All notes travel in `graph.source.notes`. Every displayed or exported network derived from OSM carries "© OpenStreetMap contributors (ODbL 1.0)".

The bundled Zurich sample (see `packages/engine/src/examples/data/README.md`) is real data downloaded once; one-way streets cut by the sample's boundary cannot be serviced legally inside it, so they are kept but marked optional at load time (recorded in its notes).

## 12. References

* L. Euler, *Solutio problematis ad geometriam situs pertinentis*, 1736.
* C. Hierholzer, *Über die Möglichkeit, einen Linienzug ohne Wiederholung und ohne Unterbrechung zu umfahren*, Math. Ann., 1873.
* Meigu Guan (Kwan Mei-Ko), *Graphic programming using odd or even points*, 1960 (English translation 1962).
* J. Edmonds, *Paths, trees, and flowers*, Canad. J. Math., 1965.
* J. Edmonds, E. L. Johnson, *Matching, Euler tours and the Chinese postman*, Math. Programming, 1973.
* Z. Galil, *Efficient algorithms for finding maximum matching in graphs*, ACM Computing Surveys, 1986.
* G. N. Frederickson, M. S. Hecht, C. E. Kim, *Approximation algorithms for some routing problems*, SIAM J. Computing, 1978.
* N. Tomizawa, *On some techniques useful for solution of transportation network problems*, Networks, 1971 (successive shortest paths with potentials).
* D. Ahr, G. Reinelt, *New heuristics and lower bounds for the min-max k-Chinese postman problem*, ESA 2002.
