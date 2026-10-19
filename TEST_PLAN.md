# SWEEP: Test Plan and Results

> A beautiful frontend with incorrect mathematics is a failed project.

**One command runs everything:** `pnpm verify`. It runs the typecheck, unit, property and integration tests, the Python oracle, the production build, and the Playwright end-to-end and accessibility suite.

## Latest recorded run (2026-10-19)

The run used Linux 6.18, a 4-core Intel Xeon at 2.10 GHz, Node 22.22.0, Python 3.13 with networkx 3.5, and Chromium 141 headless (Playwright 1.56.1, software WebGL via SwiftShader). `pnpm verify` **exited with status 0** (562 s, re-run after the city workspace was completed). The same checks run on GitHub Actions in the `verify` job; the `docker` job builds and smoke-tests the image (see [DEPLOYMENT.md](DEPLOYMENT.md)).

| Suite | Command | Result |
|---|---|---|
| Typecheck (engine, server, web) | `pnpm typecheck` | passed |
| Lint (ESLint, TypeScript rules, React hooks) | `pnpm lint` | passed, 0 warnings |
| Engine unit + property tests | `pnpm --filter @sweep/engine test` | **154 / 154 passed**: the original solver suites plus the city bundle (11), point-to-point routing on synthetic and real Pune networks (26) and zone coverage, lower bounds and fleet plans (21) |
| Server integration tests | `pnpm --filter @sweep/server test` | **38 / 38 passed** |
| Web unit tests | `pnpm --filter @sweep/web test` | **16 / 16 passed**, including the city geometry (2), shift timeline (4) and cost model (3) |
| Python oracle, undirected | `pnpm test:oracle` | **661 graphs; 537 compared with networkx, 439 with brute force; all agree**. The other 124 were rejected by SWEEP, and the oracle confirmed each has genuinely disconnected required streets. The real Zurich sample is included as its explicit undirected relaxation (one-way restrictions ignored). |
| Python oracle, directed and mixed | `pnpm test:oracle` | **1,401 graphs; 490 compared with networkx min-cost flow, 681 with a state-space search; all agree**. The other 610 were rejected by SWEEP, and the oracle confirmed each has no legal covering closed walk or has disconnected required streets. |
| Production build | `pnpm build` (and `pnpm build:static`) | passed |
| End-to-end + accessibility | `pnpm test:e2e` | **50 / 50 passed** in 8.1 min with one worker (desktop 1440×900 and mobile 390×844, both themes). This includes 10 real-Pune city tests, each checking the UI against an independent engine run (see §3). |

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
| `auth.spec.ts` | Optional accounts. Register; save to account; stored run history; reload; sign out guards the account page; a second user cannot open the first user's scenario; generic sign-in error |
| `responsive.spec.ts` (mobile) | The workspace optimises at 390 px; no horizontal overflow on the landing page or workspace |
| `a11y.spec.ts` | axe-core on `/`, `/workspace`, `/mathematics`, `/signin` and `/register` in **both themes**: no serious or critical violations (canvas elements excluded) |

### City workspace (`e2e/city.spec.ts`, real Pune data)

Every test computes its expected values with the engine on the same bundled file, never with hard-coded numbers.

* **Provenance.** The page opens without sign-in, shows OSM attribution, and its building and tile counts equal the bundle's.
* **Routing.** All 5 algorithms equal the engine optimum (relative 1e-9) and every route validates. ALT and CH settle fewer arcs than Dijkstra. The distance objective is exact too, and the printable report carries the same rows.
* **Reachability.** The 5, 10 and 15-minute lengths equal the engine's and nest.
* **Closures.** Closing a street clicked on the map gives the engine's cost on the edited network, never faster than the baseline, with all algorithms agreeing.
* **Contrast.** Measured roof/ground contrast is above 1.3:1 in both themes (measured 6.14 Velvet, 1.52 Porcelain).
* **Theme switch.** Switching theme recolours the 3D scene itself (ground luminance ×3 or more).
* **Building click.** Clicking a building shows the OSM feature, its link and its height source.
* **Coverage, rectangle zone:**
  * the directed plan equals `solveZoneCoverage` (exact min-cost flow label);
  * the undirected relaxation is labelled as such, with wrong-way counts and a bound no higher than the route;
  * the timeline ends at the engine route timed at the set speeds;
  * the cost model shows nothing until rates are entered, then fuel and CO₂ follow from the distances;
  * the report matches the plan;
  * a scenario closure and a 2-vehicle variant both equal engine runs.
* **Coverage, circle zone.** A 3-vehicle fleet with a 1 h shift equals `planFleet` (distance, makespan, vehicles used). The makespan bound does not exceed the makespan, and the timeline ends with the last vehicle.

## 4. Web unit tests (`apps/web/src/**/*.test.ts`)

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

### Real Pune network (`npx tsx bench/p2p.ts`, `npx tsx bench/coverage.ts`, 2026-10-19)

The dataset is the bundled partial extract (50 of 85 tiles): 4,160 intersections, 5,000 segments, 290.97 km.

**Point-to-point routing.** Median per-query times over 200 seeded random origin–destination pairs. Every algorithm returns the same optimum (asserted in the tests).

| Profile, objective | Directed arcs | ALT prep | CH prep (shortcuts) | Dijkstra | A* | Bidirectional | ALT | CH |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| car, time | 8,020 | 53 ms | 674 ms (27,418) | 0.453 ms (3,524 settled) | 0.468 ms (1,963) | 0.265 ms (1,562) | 0.120 ms (483) | 0.029 ms (102) |
| car, distance | 8,020 | 21 ms | 585 ms | 0.419 ms (3,581) | 0.204 ms (891) | 0.289 ms (2,084) | 0.158 ms (724) | 0.023 ms (101) |
| bicycle, time | 8,027 | 33 ms | 553 ms | 0.507 ms | 0.244 ms | 0.283 ms | 0.180 ms | 0.027 ms |
| foot, time | 8,498 | 20 ms | 564 ms | 0.478 ms | 0.268 ms | 0.365 ms | 0.090 ms | 0.029 ms |
| truck, time | 8,022 | 23 ms | 620 ms | 0.500 ms | 0.542 ms | 0.238 ms | 0.162 ms | 0.018 ms |

On the time objective, A* is weak because its admissible heuristic divides the straight-line distance by the fastest speed in the graph. ALT and CH need preprocessing; the UI reports it.

**Coverage and fleets.** Circle zones around VIT; capacity case is 1.5 t at 150 kg/km.

| Zone | Mode | Method | Route | Lower bound | Gap | Solve |
|---|---|---|---:|---:|---:|---:|
| r = 400 m (262 required segments, 13.33 km) | directed | exact min-cost flow; 6 connectors, so not proven optimal | 32.37 km | 26.65 km | 21.45 % | 597 ms |
| r = 400 m | undirected | exact Edmonds–Johnson; 6 connectors | 24.54 km | 21.38 km | 14.76 % | 998 ms |
| r = 800 m (1,121 segments, 54.47 km) | directed | exact min-cost flow; 10 connectors | 112.75 km | 108.16 km | 4.24 % | 144 ms |
| r = 800 m | undirected | candidate heuristic | 87.02 km | 77.38 km (fractional dual) | 12.46 % | 831 ms |
| whole network (5,000 segments, 290.98 km) | directed | exact min-cost flow; **proven optimal**; 28 segments unserviceable on a closed legal route, listed | 547.68 km | 547.68 km | 0 % | 197 ms |
| whole network | undirected | candidate heuristic | 445.67 km | 419.08 km | 6.35 % | 12.3 s (9.8 s of it the bound) |

Fleet examples:

* **r = 800 m, directed, 4 vehicles, finish soonest:** total 121.07 km, makespan 3.47 h against a bound of 3.34 h, feasible, in 3.7 s.
* **r = 800 m, directed, 6 vehicles, capacity 1.5 t, 6 h shift:** the split needs 12 routes, more than the 6 vehicles. The plan is reported **infeasible**. The makespan bound applies only to plans with at most 6 vehicles, so the infeasible plan's 1.38 h makespan does not contradict the 2.22 h bound.

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

SWEEP detects software rasterisers (SwiftShader, llvmpipe, Microsoft Basic Render), and the measurements above were taken with that detection active. On those rasterisers it starts the 3D scene in low-power mode: no shadows, bloom or motes, and frames are drawn only while playing or interacting. The `sweep.quality` preference (`full` / `low`) overrides the detection; the README screenshots use `full`. On GPUs, `PerformanceMonitor` still lowers resolution and drops post-processing when the frame rate declines.

Load times were measured on localhost, without network latency.

## 6. Manual visual review

Playwright screenshots were reviewed for every main screen in both themes and at phone width. A selection is in `docs/screenshots/`.

## 7. Not verified

* Real-GPU frame rates (all browser runs use software WebGL).
* Live map acquisition in CI: the browser and server tests mock the providers by design. The bundled Zurich sample was retrieved live from `overpass.osm.ch`; see `packages/engine/src/examples/data/README.md`.
* Deployment to a public host.
