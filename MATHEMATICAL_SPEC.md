# SWEEP: Mathematical Specification

This document describes exactly what the engine in `packages/engine` computes. Every statement here is implemented and covered by tests (see [TEST_PLAN.md](TEST_PLAN.md)).

## 1. Graph model

A network is an **undirected, weighted multigraph** `G = (V, E, w)`.

| Aspect | Semantics |
|---|---|
| Vertices | Intersections. Each has a unique id (`[A-Za-z0-9_.:-]{1,64}`) and planar drawing coordinates `(x, y)`, with `x` pointing east and `y` pointing south. |
| Edges | Street segments. Each has a unique id, endpoints `u` and `v`, a weight `w ≥ 0`, a `required` flag, an optional name, and an optional interior polyline `shape` used only for drawing. |
| Parallel edges | **Supported.** Two distinct streets joining the same pair of intersections are separate edges. |
| Self-loops | **Supported.** A loop contributes **2** to the degree of its vertex and is traversed as its own street. |
| Zero weights | **Supported.** For example, a plaza modelled as two nodes joined by a 0 m link. |
| Weights | Finite, `0 ≤ w ≤ 1,000,000`. Stored internally as integer milli-units (`round(1000·w)`). |
| Directed edges | **Rejected** with the code `DIRECTED_UNSUPPORTED`. One-way streets need the directed or mixed postman problem, which is not implemented. |
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
7. The property `required: false` makes a street optional; the default is required. `name` is kept. `oneway` produces a warning and is ignored.

Limitation: crossings that are not shared vertices in the source data (for example bridges, or data that is not noded) are not treated as intersections.

## 9. References

* L. Euler, *Solutio problematis ad geometriam situs pertinentis*, 1736.
* C. Hierholzer, *Über die Möglichkeit, einen Linienzug ohne Wiederholung und ohne Unterbrechung zu umfahren*, Math. Ann., 1873.
* Meigu Guan (Kwan Mei-Ko), *Graphic programming using odd or even points*, 1960 (English translation 1962).
* J. Edmonds, *Paths, trees, and flowers*, Canad. J. Math., 1965.
* J. Edmonds, E. L. Johnson, *Matching, Euler tours and the Chinese postman*, Math. Programming, 1973.
* Z. Galil, *Efficient algorithms for finding maximum matching in graphs*, ACM Computing Surveys, 1986.
