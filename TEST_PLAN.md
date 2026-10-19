# SWEEP: Test Plan and Results

> A beautiful frontend with incorrect mathematics is a failed project.

**One command runs everything:** `pnpm verify`. It runs the typecheck, unit, property and integration tests, the Python oracle, the production build, and the Playwright end-to-end and accessibility suite.

## Latest recorded run (2026-10-19)

The run used Linux 6.18, a 4-core Intel Xeon at 2.10 GHz, Node 22.22.0, Python 3.13 with networkx 3.5, and Chromium 141 headless (Playwright 1.56.1, software WebGL via SwiftShader). `pnpm verify` **exited with status 0**. The same checks run on GitHub Actions in the `verify` job; the `docker` job builds and smoke-tests the image (see [DEPLOYMENT.md](DEPLOYMENT.md)).

| Suite | Command | Result |
|---|---|---|
| Typecheck (engine, server, web) | `pnpm typecheck` | passed |
| Lint (ESLint, TypeScript rules, React hooks) | `pnpm lint` | passed, 0 warnings |
| Engine unit + property tests | `pnpm --filter @sweep/engine test` | **96 / 96 passed** |
| Server integration tests | `pnpm --filter @sweep/server test` | **38 / 38 passed** |
| Web unit tests | `pnpm --filter @sweep/web test` | **7 / 7 passed** |
| Python oracle, undirected | `pnpm test:oracle` | **661 graphs; 537 compared with networkx, 439 with brute force; all agree**. The other 124 were rejected by SWEEP, and the oracle confirmed each has genuinely disconnected required streets. The real Zurich sample is included as its explicit undirected relaxation (one-way restrictions ignored). |
| Python oracle, directed and mixed | `pnpm test:oracle` | **1,401 graphs; 490 compared with networkx min-cost flow, 681 with a state-space search; all agree**. The other 610 were rejected by SWEEP, and the oracle confirmed each has no legal covering closed walk or has disconnected required streets. |
| Production build | `pnpm build` (and `pnpm build:static`) | passed |
| End-to-end + accessibility | `pnpm test:e2e` | **37 / 37 passed** (desktop 1440×900 and mobile 390×844, both themes) |

Bugs that the end-to-end suite found during the workspace redesign, and that were then fixed:

* The export button had no accessible name.
* The wordmark was a link nested inside a link.
* The lower-bound bar in the laboratory did not say it is not a route.
* Controls scrolled into view could end up under the sticky command header. The workspace now sets `scroll-padding-top`, which also keeps keyboard focus visible.

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

## 4. Web unit tests (`apps/web/src/**/*.test.ts`)

* **Petal system:** emission is proportional to distance, not to the number of events (3 large moves and 300 small moves both give 30 petals); the pool is bounded; dead particles are recycled; nothing sprays on re-entry; intensity 0 and the bloom limit are respected.
* **Route geometry:** progress maps onto true distance (0 → 0, end → total); distance is monotone; no spatial jumps over 2,000 samples (no teleporting).
* **Route track (lanes):** the lane-offset track that drives the 3D and 2D playback is parameterised by true route distance (its total equals the engine total). Over 3,000 samples, the only discontinuities are lane changes at step boundaries. Each traversal sits to the right of its direction of travel, one lane further out per earlier pass.

## 5. Performance (measured, not targets)

### Engine (`pnpm bench`, Node 22, 4-core Xeon at 2.10 GHz)

| Network | Vertices | Edges | Odd k | Median solve |
|---|---:|---:|---:|---:|
| Königsberg | 4 | 7 | 4 | 0.71 ms |
| Old Town Grid | 16 | 24 | 8 | 1.82 ms |
| Market Avenues | 20 | 31 | 2 | 0.39 ms |
| Meridian District | 351 | 595 | 148 | 43 ms |
| synthetic 30×22 | 660 | 1,121 | 284 | 188 ms |
| synthetic 40×30 | 1,199 | 2,052 | 458 | 709 ms |
| synthetic 50×36 | 1,800 | 3,110 | 696 | 2,305 ms |
| synthetic 60×44 | 2,640 | 4,574 | 958 | 5,899 ms |

Matching dominates, as expected for O(k³). The default interactive limit is therefore **600 odd vertices** (about 1.5 s by interpolation). Raw results are in `packages/engine/bench/results.json`.

### Frontend (headless Chromium, software WebGL)

| Measurement | Result |
|---|---|
| First contentful paint `/` (local server) | 100 ms |
| First contentful paint `/workspace` (Meridian) | 100 ms |
| rAF frame interval, landing with hero off-screen and **petal field active** while the pointer moves | median 16.7 ms, p95 16.8 ms (180 frames / 3 s) |
| Same, with the petal field **disabled** | median 16.7 ms, p95 16.8 ms (181 frames / 3 s) |
| JS heap before and after 6 play/pause/restart cycles (Meridian) | 9.2 MB → 10.5 MB |
| UI re-optimise round trip, Meridian (worker-thread solve on the server) | 321 ms |
| Initial JS (gzip) | 87 KB app shell + 52 KB landing; 3D chunk (264 KB) is lazy |

**Caveats.** Hero 3D frame rates are not reported. They are dominated by SwiftShader software rendering in this container and do not represent GPU hardware. The scene lowers its resolution and disables post-processing automatically when the frame rate declines. Load times were measured on localhost without network latency.

## 6. Manual visual review

Playwright screenshots were reviewed for every main screen in both themes and at phone width. A selection is in `docs/screenshots/`.

## 7. Not verified

* Real-GPU frame rates (all browser runs use software WebGL).
* Live map acquisition in CI: the browser and server tests mock the providers by design. The bundled Zurich sample was retrieved live from `overpass.osm.ch`; see `packages/engine/src/examples/data/README.md`.
* Deployment to a public host.
