# SWEEP: Test Plan and Results

> A beautiful frontend with incorrect mathematics is a failed project.

**One command runs everything:** `pnpm verify`. It runs the typecheck, unit, property and integration tests, the Python oracle, the production build, and the Playwright end-to-end and accessibility suite.

## Latest recorded run (2026-10-20)

On the 59-tile Pune bundle, after the Directions page, the Sweep planner, the first-visit guide, route-lab links and the new landing page, and the font-settle fix for the page-load freeze. The run used Linux 6.18, a 4-core Intel Xeon at 2.10 GHz, Node 22.22.0, Python 3.13 with networkx 3.5, and Chromium headless (Playwright 1.56.1, software WebGL via SwiftShader). `pnpm verify` passed in one run (typecheck, lint, unit tests, the oracle, the build and the browser suite). The same checks run on GitHub Actions in the `verify` job; the `docker` job builds and smoke-tests the image (see [DEPLOYMENT.md](DEPLOYMENT.md)).

| Typecheck (engine, server, web) | `pnpm typecheck` | passed |
| Lint (ESLint, TypeScript rules, React hooks) | `pnpm lint` | passed, 0 warnings |
| Engine unit + property tests | `pnpm --filter @sweep/engine test` | **178 / 178 passed** (17 files, including routing, coverage, several depots, turn order and the priority deadline on the real Pune bundle) |
| Server integration tests | `pnpm --filter @sweep/server test` | **38 / 38 passed** |
| Web unit tests | `pnpm --filter @sweep/web test` | **55 / 55 passed** (15 files, including place search, directions parsing, route-lab links, the bundled streets for the sweep planner, and the sweep planner on a real cached Overpass tile) |
| Python oracle, undirected | `pnpm test:oracle` | **661 graphs; 537 compared with networkx, 439 with brute force; all agree**. The other 124 were rejected by SWEEP, and the oracle confirmed each has genuinely disconnected required streets. The real Zurich sample is included as its explicit undirected relaxation (one-way restrictions ignored). |
| Python oracle, directed and mixed | `pnpm test:oracle` | **1,401 graphs; 490 compared with networkx min-cost flow, 681 with a state-space search; all agree**. The other 610 were rejected by SWEEP, and the oracle confirmed each has no legal covering closed walk or has disconnected required streets. |
| Production build | `pnpm build` (and `pnpm build:static`) | passed |
| End-to-end + accessibility | `pnpm test:e2e` | **74 / 74 passed** in 11.4 min, one worker (desktop 1440×900 and mobile 390×844, both themes): city 19 (real Pune data), workspace 17, a11y 12, landing 8, sweep planner 7, directions 4, responsive 5, auth 2. The Directions and Sweep planner tests replace the outside map services with local stand-ins; the Sweep stand-in answers Overpass with real cached Pune tiles. The `/workspace` page-load freeze (a Chromium renderer thread-pool deadlock between web-font loading and the 3D scene's script compile) was fixed by starting every 3D scene only after the fonts settle (`docs/CITY_UX_NOTES.md` §1) |

Bugs that the end-to-end suite found during the workspace redesign, and that were then fixed:

* The export button had no accessible name.
* The wordmark was a link nested inside a link.
* The lower-bound bar in the laboratory did not say it is not a route.
* Controls scrolled into view could end up under the sticky command header. The workspace now sets `scroll-padding-top`, which also keeps keyboard focus visible.
* The "Local data cleared" toast could disappear before it was seen. Its timer started when it was pushed, and loading the large default district straight afterwards blocked the page for longer than the timer. Toasts now count only time on screen while the page is responsive, and pause while hovered or focused. This was found by the local run and by CI.

Found during the screenshot review and fixed:

* In fleet mode the header said "exact" for a split route; it now shows the proven bound (for example "≤ 1.67× opt").
* The lower-bound bar in the laboratory was misaligned with the other bars.
* Changing the fleet size relabelled the network "Edited network".
* An unknown `?example=` id silently opened the default district; it is now reported.
* On a portrait phone the route was hidden behind buildings.
* With on-demand rendering (reduced motion), camera buttons and scrubbing did not redraw the 3D view.

## 1. Mathematical tests (`packages/engine/test`)

| Test | What it proves |
|---|---|
| `solver.property.test.ts`: vs exhaustive | For **1,200 random multigraphs** (≤ 7 vertices, ≤ 11 edges, with loops, parallel edges, zero and fractional weights, optional edges), whenever SWEEP solves a graph its total equals the **exhaustive optimum** over all edge-duplication sets. Every check passes; the independent verifier passes; the greedy baseline is never better; the total is never below the lower bound. Every rejection is a genuine disconnection. |
| `solver.property.test.ts`: multiplicity | For 250 graphs, exhaustive search allowing 0, 1 or 2 extra copies gives the same optimum as 0 or 1 copies, which justifies the search space |
| `solver.property.test.ts`: determinism | The same input gives an identical route and hash |
| `matching.test.ts` | Blossom matching equals brute force on 1,500 random sparse graphs, with and without max cardinality, and its certificate always verifies. On 800 random complete metrics (k ≤ 14), blossom equals the subset DP. Optimal ties are counted exactly. A k = 120 instance carries a verified certificate. |
| `examples.test.ts` | Every bundled example: all checks pass; **Zurich Altstadt (real OSM data) is solved exactly in directed mode and never by the undirected solver** and the result is certified optimal; small examples equal the exhaustive optimum. Specific facts: Königsberg has 4 odd landmasses and 9 steps; Heritage Loop is Eulerian with zero repeats; Riverside duplicates the middle rung; Old Town has 8 odd vertices with the DP agreeing; **Crescent Quay: optimal adds 80 m, greedy adds 140 m**; Four Corners has 2 optimal pairings; Twin Districts is rejected and the suggested connectors fix it; Plaza uses a zero-weight link; Market Avenues deadheads 420 m on 3 optional streets; Meridian has more than 50 odd vertices and is certified. |
| `validation.test.ts` | Empty graphs, no required streets, duplicate or invalid ids, missing endpoints, invalid weights and coordinates, the one-way policy (refused by the undirected solver unless explicitly relaxed, accepted in directed mode), loops, parallel and zero-weight edges, isolated vertices, unreachable versus disconnected required streets, depot rules, limits |
| `directed.test.ts` (15) | A directed Eulerian cycle; balancing imbalanced vertices; a non-trivial augmentation that greedy balancing misses; a one-way dead end (no return) and an unreachable street; disconnected required streets refused; asymmetric costs; **the undirected optimum drives a one-way street backwards while the directed route does not**; the mixed-size limit; determinism; a tampered LP certificate is detected; infeasible supply; **700 random one-way networks per service rule equal the state-space search**; with all streets two-way and symmetric, `either` equals the undirected optimum |
| `fleet.test.ts` (10) | One vehicle reproduces the single route; 2, 3 and 5 vehicles cover everything with consistent costs and the proven (2 − 1/k) bound; invalid fleets; base-solver failures; the exact `total` objective; route-length limits (met, provably infeasible, unmet); directed fleets obey one-way streets; determinism; split failures keep the single route; on 120 tiny graphs the longest route lies between the brute-force min–max optimum and 1.5× it |
| `osm.test.ts` (28) | Way splitting at shared nodes only; haversine length; projection; closed ways; duplicate nodes and segments; road-class whitelist (no query injection); `oneway` semantics (yes, -1, roundabouts, motorways, reversible); streets leaving the area; largest component; errors and limits; determinism; provenance; bbox validation; **the bundled Zurich extract keeps the full response, every vertex carries its OSM position and every edge weight equals the haversine length** |
| `geojson_io.test.ts` | Splitting at shared points, geodesic length (0.001° of longitude at 18.52°N ≈ 105.5 m), skipped geometries, invalid input, `oneway` properties (yes/true/1, -1 stored reversed, no/absent, unrecognised values), JSON parsing that drops unknown fields, CSV formula-injection neutralisation, Euler circuit on multigraphs with loops |
| `sha256.test.ts` | FIPS 180-4 test vectors; canonical JSON |

**Independent oracle** (`oracle/run_oracle.py`). It shares no code with the engine.

*Undirected.* Python generates 650 random graphs (500 small, 150 with up to 40 vertices and 90 edges), plus the bundled examples. It solves them by:

* networkx `min_weight_matching` over Dijkstra distances, and
* brute force over duplication sets, for graphs with ≤ 12 edges.

*Directed and mixed.* There are 1,400 random networks (700 small and 200 larger with `both`, 500 small with `either`), plus the Zurich sample. They are solved by:

* networkx `min_cost_flow` (network simplex), for `both`;
* a Dijkstra search over (vertex, serviced obligations), for ≤ 11 obligations. This search uses no postman theory.

The oracle re-walks every SWEEP route, including the legal direction of every step in directed mode.

## 2. Integration tests (`apps/server/test`)

**`api.test.ts` (16).** Health and security headers; examples and optimisation; validation diagnostics; malformed and oversized input; CSRF (missing token, forged token, cross-origin); GeoJSON import; registration, login and logout with hashed storage; cookie flags; generic errors; registration validation; session expiry; password change revoking sessions; rate limiting; the scenario lifecycle (create, rename, duplicate, run, re-run equal to the stored run, fetch run, CSV export whose last cumulative equals the total, JSON export, delete cascading to runs); **ownership enforced on all 8 scenario and run endpoints**; account deletion.

**`routing.test.ts` (4).**
* One-way networks are refused in undirected mode with an explanation, and solved exactly in directed mode.
* Fleets are planned; split failures are reported without losing the single route.
* Runs are stored with their settings, and every vehicle route is exported.

**`maps.test.ts` (18).** Every test runs against mocked providers; no test touches the internet.
* Acquisition with conversion and provenance.
* Fallback to the next provider.
* A 502 listing every attempt when all providers fail.
* Error classification from real error chains: DNS, TLS, proxy, timeout, size, format.
* The regional Swiss instance is used only inside its coverage.
* The bbox and road classes are validated before any request.
* Cache hits keep the original retrieval time; the server still works when the cache directory cannot be created.
* No matching streets returns 422.
* At most two upstream acquisitions run at once, and identical requests are shared.
* Acquisition can be disabled, and CSRF is enforced.
* Nominatim is called with a User-Agent, results are cached, and searches are throttled to one per second.
* Geocoder failures are classified.
* **Proxy credentials are never echoed.**

## 3. Browser tests (`e2e/*.spec.ts`, Playwright)

| Spec | Coverage |
|---|---|
| `landing.spec.ts` | The hero and the live instrument; the ledger row equals engine output; WebGL canvas or fallback; the cursor field has `pointer-events: none` and links under it stay clickable; under reduced motion there is no field and the toggle state is right; theme toggle and persistence; mathematics page figures; 404 |
| `workspace.spec.ts` (17) | Opens straight into a solved city without signing in; bundled network: the total equals the engine total, and the exact route is compared with real baselines; 3D/2D stage switch; building and editing a network, where changes propagate, re-solve automatically and undo restores the result; playback play, pause and speed; the mathematical investigation (odd vertices, shortest paths, matching, verification) highlights the real record; every verification check is listed as passed; theme change; local save and reopen after reload; JSON and CSV exports equal the engine output; **the real Zurich sample solved in directed mode, with OSM attribution, compared with the two-way relaxation (wrong-way traversals) and its LP certificate**; a fleet where each vehicle animates its own route and the plan exports with validation; a GeoJSON import with a one-way dead end is explained and fixed; map acquisition through the dialog (provider response mocked); clearing local data only after confirmation; the blossom field never blocks controls; reduced motion (no field, playback jumps to the finished route) |
| `city.spec.ts` (11) | The city workspace on the real Pune bundle, always compared with an engine run on the same data: provenance and attribution; five algorithms agree and validate, and the printable Route lab report shows the same figures and a route sheet that ends at the route distance; reachability nests 5 ⊆ 10 ⊆ 15 min; a closure clicked on the map equals the engine with that segment closed; roof/ground contrast > 1.3 in both themes (measured on screenshots); theme switch rebuilds the scene; building click shows the OSM feature and height source; coverage of a rectangle (directed and undirected; honest method labels; timeline; GPX and CSV exports; cost model; report; scenario comparison); circle and polygon zones (self-crossing point refused; undo); a 3-vehicle fleet with a shift limit equal to `planFleet`, over-shift flags, the over-fleet diagnosis when the makespan bound proves the shift infeasible, and a scenario with another depot, fleet size and fuel price compared with the baseline |
| `auth.spec.ts` | Optional accounts. Register; save to account; stored run history; reload; sign out guards the account page; a second user cannot open the first user's scenario; generic sign-in error |
| `responsive.spec.ts` (mobile) | The workspace optimises at 390 px; no horizontal overflow on the landing page or workspace |
| `a11y.spec.ts` | axe-core on `/`, `/workspace`, `/mathematics`, `/signin` and `/register` in **both themes**: no serious or critical violations (canvas elements excluded) |

## 4. Web unit tests (`apps/web/src/**/*.test.ts`)

City workspace:

* **Zone drawing** (`zoneShape.test.ts`): segment intersection (crossing, touching, collinear overlap, apart); refusing points that would make an outline cross itself, fold back or repeat a vertex; simple versus self-crossing closed outlines (including concave ones); zones the engine reads with the expected extent and area; minimum sizes; closed outline rings on the boundary; the readout text.
* **Route sheet** (`routeSheet.test.ts`): on 60 real car routes, the per-junction turn classification equals the engine's `result.turns`, legs cover every arc, and leg distances add up to the route distance.
* **Shift timeline** (`timeline.test.ts`): step times from length and speed plus unloading; deterministic, monotone positions.
* **Cost model** (`costModel.test.ts`): only entered rates produce figures; the arithmetic.
* **Exports** (`coverageExport.test.ts`): on a real route, the GPX parses as XML, has one track per vehicle that drives, escapes text, and starts and ends at the right intersections; the drawn length matches the route length within 1 %; the step CSV has one row per segment plus unloading stops, with the timeline's times.
* **Formats** (`format.test.ts`): rounded seconds carry into the minute (no "51:60"); distance units.
* **Building geometry** (`geometry.test.ts`): extruded real footprints have wall winding that agrees with outward normals and roofs that face up; road ribbons face up and keep their segment for every triangle.

Network lab:

* **Petal system:** emission is proportional to distance, not to the number of events (3 large moves and 300 small moves both give 30 petals); the pool is bounded; dead particles are recycled; nothing sprays on re-entry; intensity 0 and the bloom limit are respected.
* **Route geometry:** progress maps onto true distance (0 → 0, end → total); distance is monotone; no spatial jumps over 2,000 samples (no teleporting).
* **Route track (lanes):** the lane-offset track that drives the 3D and 2D playback is parameterised by true route distance (its total equals the engine total). Over 3,000 samples, the only discontinuities are lane changes at step boundaries. Each traversal sits to the right of its direction of travel, one lane further out per earlier pass.

## 5. Performance (measured, not targets)

### Engine (`pnpm bench`, Node 22, 4-core Xeon at 2.10 GHz, 2026-10-19)

Undirected solver (`solveChinesePostman`):

| Network | Vertices | Edges | Odd k | Median solve |
|---|---:|---:|---:|---:|
| Königsberg | 4 | 7 | 4 | 1.16 ms |
| Old Town Grid | 16 | 24 | 8 | 2.43 ms |
| Market Avenues | 20 | 31 | 2 | 0.68 ms |
| Meridian District | 351 | 595 | 148 | 54 ms |
| synthetic 30×22 | 660 | 1,121 | 284 | 190 ms |
| synthetic 40×30 | 1,199 | 2,052 | 458 | 692 ms |
| synthetic 50×36 | 1,800 | 3,110 | 696 | 2,393 ms |
| synthetic 60×44 | 2,640 | 4,574 | 958 | 5,927 ms |

Matching dominates, as expected for O(k³). The default interactive limit is therefore **600 odd vertices** (about 1.5 s by interpolation).

Directed solver (`solveDirectedPostman`, `both` service rule, minimum-cost flow, certificate and verification included). The synthetic networks make every third street one-way and mark the streets that cannot be serviced on a closed legal route optional, the same treatment the Zurich sample gets:

| Network | Vertices | Streets | Required arcs | One-way | Median solve |
|---|---:|---:|---:|---:|---:|
| Zurich Altstadt (real OSM) | 177 | 188 | 304 | 29 | 10.6 ms |
| one-way 20×14 | 280 | 470 | 782 | 157 | 52 ms |
| one-way 30×22 | 660 | 1,150 | 1,887 | 384 | 145 ms |
| one-way 40×30 | 1,200 | 2,092 | 3,471 | 698 | 199 ms |

Fleets (`solveFleet`, base solve + split + verification):

| Network | Vehicles | Split | Longest route / lower bound | Median |
|---|---:|---|---:|---:|
| Meridian District | 3 | exact split DP | 1.118 | 86 ms |
| Meridian District | 8 | exact split DP | 1.386 | 85 ms |
| synthetic 40×30 | 4 | exact split DP | 1.083 | 889 ms |

Raw results are in `packages/engine/bench/results.json`.

### City workspace engine (real Pune bundle, 59 of 85 tile files: 4,753 intersections, 5,691 segments, 327.39 km)

Measured in the third session (2026-10-19) with `npx tsx packages/engine/bench/p2p.ts` and `npx tsx packages/engine/bench/coverage.ts`, on a 4-core Xeon at 2.10 GHz with Node 22.22.

Point-to-point, median over 200 random queries (arcs settled in brackets):

| Profile, objective | Dijkstra | A* | Bidirectional | ALT | CH | Preprocessing (ALT / CH) |
|---|---:|---:|---:|---:|---:|---|
| car, time | 0.529 ms (3,880) | 0.511 ms (2,001) | 0.264 ms (1,461) | 0.266 ms (787) | 0.026 ms (107) | 48.3 ms / 736 ms |
| car, distance | 0.528 ms (4,357) | 0.217 ms (927) | 0.396 ms (2,543) | 0.191 ms (806) | 0.033 ms (121) | 30.1 ms / 739 ms |
| truck, time | 0.569 ms (3,923) | 0.632 ms (2,392) | 0.233 ms (1,600) | 0.273 ms (1,013) | 0.019 ms (106) | 17.0 ms / 630 ms |
| foot, time | 0.736 ms (5,393) | 0.256 ms (1,055) | 0.435 ms (2,851) | 0.084 ms (311) | 0.037 ms (158) | 24.7 ms / 761 ms |

For the time objective, A* settles fewer arcs than Dijkstra but is not always faster here (truck). Its straight-line bound is divided by the fastest speed in the graph, so it is loose on slower streets, and each settled arc costs a heuristic evaluation; this explanation has not been profiled. The benchmark also prints the bicycle profile and the distance objective for truck and foot.

Coverage (zone, solve, bound and verification):

| Zone | Model | Method | Route | Lower bound | Gap | Time |
|---|---|---|---:|---:|---:|---:|
| circle r = 400 m (16.5 km required) | directed | exact min-cost flow, 3 connectors | 36.69 km | 32.03 km | 14.56 % | 0.7 s |
| circle r = 400 m | undirected | exact Edmonds–Johnson, 3 connectors | 28.03 km | 24.95 km | 12.36 % | 1.2 s |
| circle r = 800 m (58.7 km required) | directed | exact min-cost flow, 16 connectors | 118.93 km | 114.47 km | 3.89 % | 0.2 s |
| circle r = 800 m | undirected | candidate-matching heuristic | 92.07 km | 83.79 km | 9.87 % | 0.5 s |
| whole network (327.39 km) | directed | exact min-cost flow (optimal; 24 one-way segments unserviceable) | 622.46 km | 622.46 km | 0 % | 0.23 s |
| whole network | undirected | candidate-matching heuristic | 499.16 km | 467.20 km | 6.84 % | 5.8 s (2.1 s of it the lower bound) |

The lower bound does not include the cost of joining separate street groups (the connector paths in the circle zones), so there the gap is an upper limit on the distance from the optimum, not an estimate of it. Fleet plans for these zones take 0.3–3.4 s (distance table, split and local search); the benchmark prints each one.

History of the whole-network undirected bound:

* The sparse Jonker–Volgenant assignment (third session) took it from 6.0 s to 1.55 s on the 54-tile network (3,606 odd intersections), with a slightly stronger value.
* The second session's heap and flow speed-up had taken the 47-tile network from 20.2 s to 9.4 s, with an identical route, bound and gap.

Turn-aware order (truck turn penalties: left 4 s, right 10 s, U-turn 20 s), measured with `orderCoverageForTurns` on circles centred on VIT, with the depot at the nearest intersection. Distances are unchanged by construction.

| Zone | Model | Turn penalties, engine order | After ordering | Lower bound for these traversals | U-turns before → after | Right turns before → after | Time |
|---|---|---:|---:|---:|---:|---:|---:|
| r = 300 m | directed | 80.6 min | 41.7 min | 37.8 min | 138 → 66 | 148 → 36 | 44 ms |
| r = 300 m | undirected | 44.8 min | 37.7 min | 37.0 min | 62 → 50 | 99 → 78 | 30 ms |
| r = 600 m | directed | 229.4 min | 142.8 min | 131.8 min | 403 → 250 | 401 → 102 | 24 ms |
| r = 600 m | undirected | 157.6 min | 141.2 min | 136.2 min | 239 → 219 | 337 → 267 | 29 ms |
| r = 1200 m | directed | 629.0 min | 438.7 min | 400.0 min | 1,107 → 820 | 1,055 → 218 | 122 ms |
| r = 1200 m | undirected | 489.4 min | 436.0 min | 425.1 min | 757 → 684 | 1,020 → 768 | 74 ms |

Most remaining U-turns are at dead ends, where they are unavoidable. After ordering, 600 m directed has 49 U-turns away from dead ends, down from 202. The bundle has no mapped turn restrictions yet, so banned-turn avoidance is tested only on synthetic instances (`turns.test.ts`).

### Frontend (headless Chromium, software WebGL via SwiftShader, local server)

| Measurement | Result |
|---|---|
| First contentful paint `/` | 152 ms |
| First contentful paint `/workspace` | 116 ms |
| `/workspace`: navigation until the solved Meridian route is on screen | 2.8 s (includes building the 3D district in software) |
| `POST /api/route`, Meridian, measured with curl | 0.31 s |
| Re-optimise round trip in the UI, Meridian, **2D stage** | 0.83 s |
| Re-optimise round trip, **3D stage, idle** | 2.9 s. The API answers at 0.75 s; the rest is software-rendered frames. Main-thread JavaScript for a new result is about 100 ms (CPU profile, mostly building the route tube). |
| Re-optimise round trip, 3D stage **while the route plays** | about 12 s here: continuously animated software WebGL saturates the 4 CPU cores that the local server also uses |
| JS heap before and after 6 play/pause/restart cycles (Meridian, 3D) | 26.9 MB → 29.0 MB |
| JS (gzip) | 114 KB app shell; workspace 48 KB and landing 48 KB, each loaded on its route; three.js and R3F 258 KB plus the district scene 11 KB, lazy; engine worker 24 KB |

**Caveats.** Frame rates are not reported: in this container every frame is rasterised on the CPU (about 0.75 s per frame at 1440×900 with shadows and bloom), which says nothing about GPU hardware.

SWEEP detects software rasterisers (SwiftShader, llvmpipe, Microsoft Basic Render) from each scene's own WebGL context, and the measurements above were taken with that detection active. In low-power mode there are no shadows, bloom or motes, and frames are drawn only while playing or interacting. Every scene starts in low-power mode and leaves it once its context shows a hardware GPU. No throwaway probe context is created, because one caused the intermittent page-load freeze (HANDOFF §4.1). The `sweep.quality` preference (`full` / `low`) overrides the detection; the README screenshots use `full`. On GPUs, `PerformanceMonitor` still lowers resolution and drops post-processing when the frame rate declines.

Load times were measured on localhost, without network latency.

## 6. Manual visual review

Playwright screenshots were reviewed for every main screen in both themes and at phone width. A selection is in `docs/screenshots/`.

## 7. Not verified

* Real-GPU frame rates (all browser runs use software WebGL).
* Live map acquisition in CI: the browser and server tests mock the providers by design. The bundled Zurich sample was retrieved live from `overpass.osm.ch`; see `packages/engine/src/examples/data/README.md`.
* Deployment to a public host.
