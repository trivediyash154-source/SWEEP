# SWEEP: handoff to the next Claude session

This file is written for a Claude Code session that takes over the city-scale redesign of SWEEP. Read it fully before changing anything.

* Read `IMPLEMENTATION_STATUS.md` next. It is the factual record of what has been verified.
* The original product brief is in `PROJECT_BRIEF.md` and `PRD.md`; the earlier engine maths is in `MATHEMATICAL_SPEC.md`.

Snapshot: 2026-10-19, evening (see §3 for which session did what). Earlier snapshot text, from the second session, follows. Work continues on branch `claude/peaceful-cray-qmjciz` (draft PR trivediyash154-source/SWEEP#2), stacked on `claude/laughing-ramanujan-wg70al` (draft PR trivediyash154-source/SWEEP#1). **Two sessions worked in parallel** that afternoon; the second session's branch merged PR #1's branch in at 17:15 UTC, keeping the fuller implementation of each overlapping feature. `docs/FINAL_REPORT.md` was written by the other session before that merge, so check its figures against this file. The commit that updates this file holds all work up to that point.

---

## 0. What the owner asked for (the "execution directive")

**Build "SWEEP — real city, real routing, real decisions".** Execute; don't stop at plans. Target: **Pune**, starting with the VIT Bibwewadi area, with an architecture that also works for other regions.

The product has two separate workflows:

1. **Point-to-point routing and algorithm comparison** ("who reaches first, and why").
2. **Street coverage and municipal fleet planning** (sweeping, waste collection).

### Non-negotiable rules

The owner was explicit about every one of these.

**Algorithms and claims**

* Preserve the exact undirected Chinese Postman solver (`packages/engine/src/solve.ts`) and all of its tests.
* Never label a directed network as solved by the undirected algorithm.
* Never present a heuristic result as a proven optimum. Only valid lower bounds and gaps are allowed.
* Never fabricate map data, building heights, algorithm timings, solver guarantees, fuel, CO₂ or savings.
* Never call a small sample "the full Pune map". Never call synthetic data real city data.
* Do not claim a feature until it is implemented **and tested**.
* No invalid shortcuts. Audit an existing feature before discarding it.

**Product**

* No authentication gate. `/workspace` opens directly, with no sign-in or registration.

**Tests**

* Do not weaken tests, delete failing tests, or change expected values to hide bugs.

**Security**

* Never print or commit secrets, and never put credentials into the Docker image.
* Do not scrape blocked sites or bypass access controls. Do not keep retrying a confirmed permission denial.

**Git and deployment**

* Pushing to the session's working branch is authorized.
* Merging, deploying, and changing repository permissions or branch protection are **not** authorized without asking.
* Do not put a model identifier in commits, PR text or code.

### Reference repository

The owner mentioned a "reverse engineering reference repo", but no URL ever arrived. Ask for it once. If it never comes, say in the final report that it was not reviewed.

### The owner's original complaints (what "done" must fix)

* Dark-mode (Velvet) buildings were invisible.
* The 5–10-building toy district looked fake.
* The playback speed buttons were useless; they must become a real shift timeline.
* The owner wants a product they could sell, built to a PhD level.

---

## 1. Environment setup (fresh container)

```bash
cd sweep
pnpm install                     # Node 22, pnpm 10 (see package.json "packageManager")
pnpm --filter @sweep/engine build
pnpm --filter @sweep/web build   # e2e serves the built app
npx playwright test --list       # Chromium is pre-installed in Claude cloud containers; do not run "playwright install"
pip install -r oracle/requirements.txt && python3 -I oracle/run_oracle.py  # independent oracle
```

### Useful commands

| Command | What it does |
|---|---|
| `pnpm typecheck` | `tsc` for every package |
| `pnpm lint` | ESLint with `--max-warnings=0` |
| `pnpm test` | vitest: engine 154 tests, server 38, web 26 |
| `pnpm test:e2e` | Playwright (desktop and mobile projects; 2 workers; port 8790) |
| `pnpm verify` | everything above, plus the oracle and the build. **This must exit 0 before the final report.** |
| `pnpm bench` | engine benchmarks (`packages/engine/bench/*.ts`, including `p2p.ts` and `coverage.ts`) |
| `pnpm city:acquire pune-bibwewadi` | resumable OSM acquisition (see §3) |
| `pnpm city:build pune-bibwewadi` | merges cached tiles → `apps/web/public/cities/pune-bibwewadi.json` + `index.json` |

### Dev server

Run `pnpm dev`, or build and then run `node scripts/e2e-server.mjs 8790` to serve the built app plus the API. The city workspace is at `http://localhost:8790/workspace`. The old abstract-graph lab is at `/lab`.

### Gotchas

* **`.gitignore` has a repo-wide `coverage/` rule** (test-coverage output). It once silently dropped `packages/engine/src/coverage/` from a commit. A negation now re-includes it. After adding a new source folder, check `git status --ignored`.
* **Do not run `pkill -f <pattern>`** in a command line that itself contains the pattern. It kills its own shell (exit 144).
* **Do not commit OSM tiles one at a time.** Each push triggers CI, each CI result wakes the session, and the loop burns the owner's usage. Commit the cache once, when a download run ends.
* **The cloud proxy may block Overpass.** In the second session every mirror (`maps.mail.ru`, `overpass-api.de`, `overpass.private.coffee`) returned `403` on CONNECT: the environment's network policy, not the servers. Check with `curl -sS "$HTTPS_PROXY/__agentproxy/status"` and a `curl` to the mirror. If it is a policy denial, stop the acquisition (the rules say not to retry a confirmed denial) and ask the owner to allow the host in the environment's network settings.
* **Never create a throwaway WebGL context** (a feature probe) on a page that will create a scene. On software rasterisers it stalls the main thread (see §4.1). Detect the renderer from the scene's own context.
* **Pick modes are read from a ref, not a prop.** Props inside `<Canvas>` reach the R3F reconciler late on slow frames, so `GeoCityScene` keeps `pickMode`, `onPick` and `onHover` in a DOM-side ref that the picker reads at event time. Keep it that way; passing the mode as a prop made quick clicks after choosing a tool resolve with the old mode (this was the intermittent "close a road" e2e failure).
* **Wait for the camera with `__sweepCity.cameraMoving()`** before computing click positions in e2e tests. A fixed timeout or "projection unchanged for 400 ms" is not enough when one software-rendered frame takes over a second.
* **Headless Chromium uses SwiftShader** (software WebGL). The app detects this and starts the 3D scene in low-power mode (`lib/webgl.ts` → `startInLowPower`; demand frameloop, DPR 1, no shadows). Two browsers in parallel on four cores make the real-data tests slow, so the city spec has a 180 s describe timeout. The assertions were not changed.

---

## 2. Repository map (new code from this redesign)

### Engine (`packages/engine/src`, all exported from `index.ts`)

**`city/`: the city bundle format `sweep-city/1`**

* Local equirectangular frame centred on the bbox: x east, y **south**, in metres. Coordinates are stored as integer decimetres. Node lon/lat is also stored, × 1e7.
* `buildCityBundle(input)` builds a bundle from merged Overpass elements. `decodeCityBundle(json)` turns it into a `CityModel` of typed arrays: `nodeX/nodeY`, `segU/segV/segLen/segWay/segPtOff/segXY`, `ways[]`, buildings `bRingOff/bRingXY/bHeight/bHeightSrc/bOsm`, `region`, `focus`, and `provenance`.
* `buildings.ts` holds the height rules:
  * the `height` tag is used first;
  * otherwise `building:levels` × 3.0 m;
  * otherwise an **estimate**, flagged with `HeightSource` = estimate. Estimates use `KIND_LEVELS` or area bands (<40 m² → 1 level, <120 → 2, <400 → 3, <1,200 → 4, else 5).
* `buildings.ts` also validates rings: closed, self-intersection checked first, area ≥ 1 m², positive winding.
* Turn restrictions are supported for **via-node only**. Via-way restrictions are counted as unsupported, never silently applied.
* Tests: `test/city.test.ts`.

**`p2p/`: point-to-point routing**

* Graph: a turn-expanded CSR graph where arc = segment × 2 + direction.
* Profiles: `car`, `truck`, `bicycle`, `foot`. See `profiles.ts`; `profileAssumptions(profile)` returns the human-readable limitations.
* Turn penalties: right 10 s, left 4 s, U-turn 20 s. U-turns are allowed only at dead ends. Pune drives on the left.
* `new RoutingEngine(city, profile, { closedSegments, onewayOverrides, vehicle })`, then `.query(alg, { origin, destination, objective: 'time'|'distance' }, { repeat, trace })`.
  * Algorithms (`ALGORITHMS`): `dijkstra`, `astar`, `bidirectional`, `alt` (8 landmarks), `ch` (contraction hierarchies).
  * Runtime is the median of untraced runs. A trace records the real settle order.
* `validateRoute(city, graph, query, result)` is an independent validator.
* `reachability(graph, origin, [300, 600, 900])` returns isochrones that nest monotonically.
* Tests: `test/p2p.test.ts` and `test/p2p.real.test.ts`, which run on the real bundle. All algorithms agree to 1e-9.

**`coverage/`: street coverage on real extracts**

* `zoneCoverageGraph(city, { zone: rect|circle|polygon, roadClasses, direction, closedSegments, onewayOverrides, depotId })`:
  * a segment whose midpoint lies in the zone is required; every other segment is optional deadhead;
  * returns `{ graph, report, edgeSegment, vertexNode }`. `nearestNode(city, x, y)` snaps a point to a vertex.
* `solveZoneCoverage(zoneGraph.graph, { direction, depotId })` picks its method:
  * **directed:** exact min-cost flow;
  * **undirected with ≤ 600 odd vertices:** exact Edmonds–Johnson;
  * **larger undirected:** `heuristic-candidate-matching`, with a dual-feasible fractional-matching **lower bound** and the gap.
* `optimal` is true only for an exact method on the unrelaxed problem. When the required streets are disconnected, connector paths are added and reported.
* `planFleet(graph, { vehicles, depotId, dumpId, direction, objective: 'min-total'|'min-makespan', capacity, demandPerKm, shiftSeconds, serviceSpeedKmh, deadheadSpeedKmh, dumpSeconds, coverage })` works route-first, cluster-second:
  * an optimal giant-tour split DP under capacity, shift and dump-site constraints, followed by local search;
  * returns valid fleet lower bounds (`lowerBounds`), `gaps`, and per-vehicle validation (`verifyFleetPlan`).
* Tests: `test/coverage.test.ts`.

**Other engine changes**

* `osm.ts` gained `OsmImportOptions.origin`.

### Data acquisition (`scripts/city/`, `data/regions/`)

* `data/regions/pune-bibwewadi.json` defines the region:
  * bbox 18.445–18.481 N, 73.850–73.888 E (about 4 × 4 km), in 0.006° tiles;
  * a VIT focus point, the road classes, and the endpoints.
* `scripts/city/acquire.ts` runs a polite, resumable Overpass acquisition:
  * one request at a time, at least 4 s apart, with a SWEEP User-Agent;
  * 6 attempts with backoff, and endpoint fallback;
  * a checkpoint manifest at `data/cache/osm/<region>/manifest.json`, with tiles in `tiles/`.
* `scripts/city/build.ts` merges, validates and round-trips the data, and writes provenance into the bundle: endpoints, OSM base dates, tiles ok/missing, queries and limitations.

### Web: the city workspace (`apps/web/src/city/`, route `/workspace`)

| File | Role |
|---|---|
| `CityWorkspace.tsx` | shell: top bar with mode tabs Route lab / Coverage & fleet / Scenarios; camera tools; inspector; legend with OSM attribution; provenance dialog. It exposes `window.__sweepCity = { project, state, route, scenarios, sample }` for e2e tests. Escape cancels a pick mode. |
| `GeoCityScene.tsx` | R3F scene: chunked extruded real buildings, ribbon roads, overlays (paths, explorations, reach, markers, highlights, vehicles, zone), camera rig framing `city.region`, `setViewOffset` for the 420 px side panel, and the picker (segment index plus ground ray; buildings are raycast only on click and only when `pickMode === 'any'`). |
| `materials.ts` | `CITY_PALETTE` for Velvet and Porcelain, plus shader-patched building materials (walls, roofs, windows, rim, estimated-height hatch). |
| `geometry.ts`, `geometry.worker.ts` | mesh building off the main thread |
| `store.ts` | `useCity` (status, city, meshes, mode, camera, hover, selection, pickTarget, showEstimates) |
| `routeStore.ts`, `router.worker.ts`, `routerClient.ts` | Route Lab state, plus the worker that runs every algorithm on one `RoutingEngine` per (profile, scenario key) |
| `scenario.ts`, `panels/ScenarioPanel.tsx` | scenarios (`closed[]`, `oneway[]`, and `plan` overrides: depot, vehicles, shift, cost assumptions) with real recalculation and a baseline comparison. `effectiveInputs` in `coverageStore.ts` applies a scenario's plan overrides to the coverage panel's inputs. |
| `panels/RouteLab.tsx` | endpoint search that snaps to junctions; profiles; objective; algorithm chips; results rows; agreement banner; replay; reach bands; assumptions |
| `overlays.ts` | route path, search exploration ribbons, reach ribbons, scenario highlights |
| `coverage.worker.ts`, `coverageClient.ts`, `coverageStore.ts` | coverage plans off the main thread: `zoneCoverageGraph` → `solveZoneCoverage` → `planFleet` (when there is more than one vehicle, or a capacity, shift or disposal site is set). Routes come back as arcs. The store holds zone, depot, dump, classes, direction, fleet, result and `resultKey` (a stale flag that includes the scenario key). |
| `panels/CoveragePanel.tsx`, `coverageOverlays.ts` | **done**: the Coverage & fleet panel (rectangle zone drawn with two clicks; depot and disposal picks; road classes; respect or ignore one-ways; fleet inputs; results with method, guarantee, lower bound, gap, per-vehicle table, fleet bounds and checks) and its map layers (one coloured path per vehicle, zone outline, markers) |
| `timeline.ts`, `shift.ts`, `panels/Timeline.tsx` | **done**: the deterministic shift timeline (unit-tested), with shift start, clock, scrubber, fixed-rate playback, per-vehicle street, % done, finish time, over-shift warnings, and vehicle markers on the map |
| `costModel.ts` | **done**: cost and CO₂ estimate from user assumptions only (unit-tested). Applied to the distances and vehicle hours of the routes actually driven (`summarise` in `coverageStore.ts`). |
| `zoneShape.ts` | **done**: rectangle, circle and polygon zones (construction, simplicity checks, outline, labels; unit-tested). Zone drawing uses pick target `zone` and the scene's `ground` pick mode. |
| `routeSheet.ts`, `panels/RouteReport.tsx` | **done**: street-by-street route sheet whose turns use the engine's `arcDirections` and `classifyTurn` (unit-tested against `result.turns` on real routes), and the printable Route lab report |
| `format.ts` | `fmtDist`, `fmtTime` (re-exported from `panels/RouteLab.tsx`; unit-tested) |
| `coverageExport.ts` | **done**: GPX tracks and a step CSV of a coverage plan (unit- and e2e-tested). Uses the engine's new `localUnprojection` (inverse of the bundle projection, tested against the stored node coordinates). |
| `Inspector.tsx`, `Provenance.tsx` | feature details (height source, OSM links) and the data provenance dialog |

### Changes elsewhere in the web app

* The old abstract workspace moved from `/workspace` to `/lab`. Links were updated in Landing, Report, Auth, Account, SiteNav and ReportSections.
* The Velvet materials in the landing `three/CityScene.tsx` and the lab `three/DistrictScene.tsx` were lifted so buildings are visible.

### E2E tests

`e2e/city.spec.ts` checks the city workspace against the engine on the bundled data:

* provenance, attribution and the "partial" chip;
* equivalence of all five algorithms, validation of every route, and the printable Route lab report (same time, distance and search work; the route sheet's last leg ends at the route distance);
* reachability nesting;
* a closure clicked on the map triggering a recalculation that equals the engine;
* measured roof/ground contrast in both themes (must be > 1.3);
* the theme switch rebuilding the 3D scene;
* a building click showing the OSM feature and its height source;
* coverage of a drawn rectangle in directed and undirected mode, with honest method labels, the shift timeline, the cost model, the printable report and the scenario comparison;
* **circle and free-outline zones**, each planned and compared with an engine run on the exact zone the UI built, including refusal of a self-crossing point and undo;
* **a 3-vehicle fleet with a shift limit**: routes, totals and bounds equal `planFleet`; the timeline flags exactly the over-shift vehicles; a 15-minute shift that the makespan bound proves infeasible must show the "fleet too small" diagnosis; and a scenario with another depot, 2 vehicles and a higher fuel price is compared with the baseline (both plans equal the engine, and the cost row uses each side's assumptions).

Helpers: `e2e/png.ts` decodes screenshots for pixel measurements; `e2e/engine.ts` re-exports engine functions; `waitForCamera` waits on `__sweepCity.cameraMoving()`.

---

## 3. Current state (verified numbers; do not restate them without re-measuring)

Four sessions have worked on this branch.

* **Third session.** It added several depots, turn-aware order, the faster lower bound, the freeze fix and the static-build worker fix.
* **Fourth session.** It ran in parallel with the third and believed the third session's container had ended. It added the main-roads deadline, fixed a test time budget and refreshed the docs on 55 tiles.
* **Third session again.** Its container was still alive. It pushed its 4 extra tile files (59 of 85), rebuilt the bundle, re-measured and updated these docs on 59 tiles, and replaced the turn checkbox with a two-button control.

### Checks that pass (2026-10-20, 59-tile bundle)

* `pnpm typecheck` ✓ and `pnpm lint` ✓ (0 warnings).
* Unit tests: engine 178/178 (17 files), server 38/38, web 50/50 (14 files).
* Both Python oracles: all comparisons agree.
* `pnpm build` and `pnpm build:static` ✓.
* E2E: **70 of 70 passed** in one full `pnpm verify` run (9.5 min, one worker): 19 on the real Pune data, 6 on the Sweep planner, 4 on Directions.
* The static build, served by a plain file server with no API, was checked in headless Chromium: landing page, lab, `/#/workspace` city load, the Route lab (all five algorithms agree) and a coverage plan, with no console errors or failed requests.

### Bundled dataset

`apps/web/public/cities/pune-bibwewadi.json` is real but **partial**: built from 59 of 85 tile files (`pnpm city:build pune-bibwewadi`, 1.57 MB).

| Item | Value |
|---|---|
| Area | 16.04 km² |
| Nodes | 4,753 |
| Segments | 5,691 (327.39 km) |
| One-way segments | 583 |
| Buildings | 12,404 (1 with a `height` tag, 14 from `building:levels`, 12,389 estimated) |
| Turn restrictions | 0 (the region-wide restriction query has not been fetched) |

The UI shows a "partial" chip and lists the missing tiles in provenance.

### Raw tile cache

Committed under `data/cache/osm/pune-bibwewadi/`: **59 tile files OK** out of 85 (42 tiles × {streets, buildings} + 1 restrictions query). One file is marked failed (`t2_4:buildings`), and the rest have not been attempted yet, including the restrictions query. Run `pnpm city:acquire pune-bibwewadi --status` for the exact list.

To continue, rerun the acquisition; it resumes from the manifest:

```bash
NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt pnpm city:acquire pune-bibwewadi   # long-running; run in background, log to a file
pnpm city:acquire pune-bibwewadi --status                                                           # progress
pnpm city:build pune-bibwewadi                                                                      # rebuild the bundle once more tiles are ok
```

* The two environment variables are needed in the Claude cloud container, because outbound HTTPS goes through a proxy.
* Whether the mirror is reachable depends on the environment's network policy. In the second and fourth sessions the proxy refused every Overpass mirror (HTTP 403 on CONNECT): stop at once, do not retry, and ask the owner to allow `maps.mail.ru` in the environment's network settings. In the third session `maps.mail.ru` was reachable but slow (mostly HTTP 504, about 4 tiles an hour).
* Do **not** hammer the servers, and commit the cache once per run, not per tile. Commit it before the session can end, so downloads are not lost again.

### Benchmarks (59-tile bundle, third session; full tables in TEST_PLAN §5)

* P2P, car by time, median of 200 queries: Dijkstra 0.53 ms, A* 0.51 ms, bidirectional 0.26 ms, ALT 0.27 ms, CH 0.026 ms. CH preprocessing takes 585–764 ms across profiles.
* Coverage, whole network (5,691 segments, 327.4 km):
  * directed exact: 622.46 km in 0.24 s;
  * undirected heuristic: 499.16 km against a lower bound of 467.20 km (gap 6.84 %) in **5.6–5.8 s**, of which 1.9–2.1 s is the lower bound.
* History:
  * 20.2 s → 9.4 s from the typed-array heaps (second session, 47 tiles);
  * bound 6.0 s → 1.55 s from the sparse assignment start (third session, 54 tiles).
* Turn-aware order, 600 m zone around VIT, one-ways respected: 229 → 143 min of turn penalties, against a bound of 132 min, in about 25 ms.

### Phase status

| Phase | Status |
|---|---|
| 1 Audit | done |
| 2 Real Pune data | partial: 59 of 85 tile files; needs an environment that can reach an Overpass mirror, and patience (it is overloaded) |
| 3 Renderer and themes | done for the workspace; same-camera screenshots of both themes in `docs/screenshots/city-*.png`; page-load freeze fixed (§4.1) |
| 4–6 Routing, profiles, reachability | done and tested; printable Route lab report with route sheet done and tested |
| 7 Coverage | done: rectangle, circle and polygon zones; turn-aware order; faster whole-network bound; engine and UI tested against each other |
| 8 Fleet, scenarios, cost, report | done: multi-vehicle plans with honest over-fleet diagnosis, several depots, a main-roads deadline with bounds, scenario plan overrides (depot, vehicles, shift, costs) with baseline comparison, cost from the routes actually driven, printable coverage report, GPX/CSV exports |
| 9 Shift timeline | done, including multi-vehicle plans (e2e) |
| 10 Docs, full verify, final report | docs refreshed in the fourth session (README, IMPLEMENTATION_STATUS, TEST_PLAN, DEPLOYMENT, this file, `docs/FINAL_REPORT.md`); MATHEMATICAL_SPEC §12–17 |
| 11 Public deployment | not done: the owner asked for the Vercel deployment to be updated; see §5 |

---

## 4. What to do next, in order

### 4.1 Keep the suite green and confirm on CI

Run `npx playwright test --reporter=line`. Inspect failures with `test-results/<name>/trace.zip` (unzip and read `0-trace.trace`, or `npx playwright show-trace`). Fix root causes; never weaken or delete tests.

**Resolved in the third session: the intermittent page-load freeze.**

* **Reproducer.** Load `/workspace` repeatedly in one headless Chromium (SwiftShader). 11 of 60 loads stalled. In every stall, `page.evaluate` and a CDP `Debugger.pause` both went unanswered, so the main thread was blocked outside JavaScript.
* **Bisection:**

  | Run | Stalls |
  |---|---|
  | as built | 11 of 60 |
  | `--disable-webgl --disable-3d-apis` | 0 of 60 |
  | probe creates no context | 0 of 60 |
  | after the fix | 0 of 120 |

* **Cause.** The feature probe in `lib/webgl.ts` created a throwaway WebGL context, read the renderer name and called `loseContext()`. On SwiftShader this left the page's main thread blocked in a later synchronous GPU call.
* **Fix.**
  * `webglAvailable()` now only checks that the API exists.
  * Software rendering is detected from each scene's own context (`lowPowerFor(gl)` in `onCreated`).
  * Scenes start in low power until a hardware GPU is confirmed. The `sweep.quality` preference still wins.
  * Every 3D scene is wrapped in `components/WebGLBoundary` with a readable fallback, in case context creation fails.

**Resolved in the second session:** the intermittent "close a road" failure. The click arrived, but the picker still had the previous pick mode because the prop had not yet reached the R3F reconciler (main-thread frame gaps of up to 3 s in SwiftShader). The picker now reads the mode from a DOM-side ref.

### 4.2 Finish the Pune data (needs the owner)

Ask the owner to allow an Overpass mirror in the environment's network settings, then resume the acquisition (§3), rebuild the bundle, run the full suite and update the numbers in README, this file and IMPLEMENTATION_STATUS. The tests compare the UI with the engine on whatever bundle is present, so they need no changes for new data.

### 4.3 Faster lower bound for large undirected zones: DONE (third session)

The new sparse Jonker–Volgenant assignment (`coverage/assignment.ts`, unit-tested against brute force and min-cost flow) replaced the general min-cost flow in the optimal-assignment start. On the whole 54-tile network (3,606 odd intersections) the bound went from **6.0 s to 1.55 s**, and the value from 437,285.7 m to 437,302.1 m (slightly stronger, still feasible for every pair). The history is kept below.


Profiled on the whole 47-tile network (3,032 odd intersections): the optional optimal-assignment start of `fractionalMatchingDual` (`engine/coverage/bounds.ts`) dominated, with 9.5 s in `minCostFlow` and 1.8 s in its pricing searches. Without that start the bound takes 0.13 s but is weaker (T-join part 96.0 km instead of 106.4 km). The second session replaced the allocation-heavy heaps in `mincostflow.ts` and `coverage/arcs.ts` with typed-array heaps (same ordering, so results are bit-identical; engine tests and both oracles agree) and flattened the flow's arcs: the bound now takes about 6 s. Next idea: a dedicated sparse assignment solver with a column-reduction start for this bound only (not in the shared exact flow); it may return a different optimal dual, so compare bound values.

### 4.4 Screenshots and the final report

* Same-camera screenshots of `/workspace` in both themes, the Route lab and a coverage plan are in `docs/screenshots/city-*.png` and in README, recaptured on the 59-tile bundle in the third session's final pass. Recapture them with `node scripts/city-screenshots.mjs` (server on :8790) after the data changes.
* The final report for the owner is `docs/FINAL_REPORT.md`. It was updated to the 59-tile bundle, with every feature built so far and the re-measured contrast, benchmarks and test results. Update it whenever the data or the test figures change.

### 4.5 Next features

* **Several depots in one plan: DONE** (third session).
  * Engine: `planMultiDepotFleet`, which partitions streets by nearest round trip and then plans each depot.
  * The lower bounds hold for any partition (MATHEMATICAL_SPEC §15).
  * UI: "Add another depot" in the Coverage panel, with vehicles per depot, per-depot results, a depot column per vehicle, map markers and the report.
  * Tests: engine (4), and e2e against the engine.
* **Turn costs in coverage: DONE** (third session), as a turn-aware order of the same traversals.
  * Engine: `orderForTurns` (`coverage/turns.ts`). It pairs arrivals and departures exactly at each intersection, then merges the sub-tours cheapest first. The distance is unchanged.
  * It reports the turn counts, the penalty time, and lower bounds valid for every order of the same traversals (MATHEMATICAL_SPEC §16).
  * It runs on single routes and on fleet routes, including several depots. Routes that unload mid-way keep their order.
  * Real Pune, 600 m zone around VIT, one-ways respected: 229 → 143 min of turn penalties, against a bound of 132 min, in about 20 ms.
  * The bundle has no mapped turn restrictions yet: the region-wide restriction query has not been fetched. Banned-turn handling is tested on synthetic instances only.
  * UI: a "Turns" control ("Fewer U-turns", the default, or "Solver order"), a Turns row in the results and the report.
  * Tests: engine (7, including exhaustive search), e2e against the engine.
* **Priority deadline (time windows, latest finish): DONE** (fourth session).
  * Engine: `planFleet` option `priority: { edgeIds, deadlineSeconds }`. The deadline is a route constraint in evaluation, both splits and local search. Three starting points: coverage order, priority first, and two-phase (priority streets split among the vehicles, the rest appended). A turn order never makes a met deadline late.
  * Bounds valid for any plan with k vehicles: the finish time, and the vehicles needed (MATHEMATICAL_SPEC §17). A proven-impossible deadline gets the over-fleet diagnosis. If no fleet of any size can meet it, the plan ignores it and says so.
  * `verifyFleetPlan` recomputes every priority finish time from the steps.
  * UI: "Main roads within" (hours) in the Fleet settings, a "Main roads" result row, a per-vehicle "Main roads done" column, and the report. Main roads are trunk to tertiary with their links. One depot only: the engine refuses it with several depots.
  * Real Pune, 400 m zone, 2 vehicles: a 10-minute deadline is met (9.0 min) with a 159-minute shift, against 158.8 min at a 20-minute deadline.
  * Tests: engine (8), e2e against the engine.
* **Not built:** earliest-start windows (service not before a time), the deadline with several depots, and per-street windows chosen in the UI. The coverage solvers also do not choose deadhead streets to reduce turns; only the order is turn-aware.

### 4.6 Real-map pages (third session, final pass): DONE and tested

The owner wants a big map. These pages give real data at any size: Directions anywhere, and coverage of any real zone up to 25 km².

* **`/directions`**
  * Files: `apps/web/src/directions/DirectionsPage.tsx`, `lib/directions.ts` (OSRM client, instructions, server fallback), `lib/geocode.ts` (Photon, Nominatim fallback), `map/MapCanvas.tsx` (MapLibre 5.10, OpenFreeMap styles, OSM raster fallback), `map/PlaceSearch.tsx`.
  * Routes are OSRM's, never SWEEP's, and the page says so.
* **`/sweep`**
  * Files: `apps/web/src/sweep/SweepPage.tsx`, `sweep/plan.ts`, `sweep/sweep.worker.ts`.
  * Zones up to 4 km² use `acquireMap` (through the server when there is one). Larger zones, up to 25 km², use `acquireLargeArea` in `lib/maps.ts`: browser tiles of at most 3.5 km², sequential, merged by OSM id.
  * The plan is the engine unchanged: `solveZoneCoverage`, `planFleet` and `orderCoverageForTurns`.
* **Tests**
  * Unit: `lib/directions.test.ts`, `lib/geocode.test.ts`, `sweep/plan.test.ts` (on a real cached Pune Overpass response).
  * e2e: `e2e/directions.spec.ts`, `e2e/sweep.spec.ts`. External services are replaced by stand-ins in their real formats; Overpass answers with the cached real Pune tiles.
* **Not verified against the live services** from the Claude container: its network policy denied those hosts at the time. The live Vercel site calls them from the visitor's browser.
* **Parallel session.** A second Claude session (the city-UX session) works on `claude/city-ux` (draft PR #3) and owns `apps/web/src/city/**`, `three/**` and `landing/**`. Instructions go to it as `[main]` comments on PR #3; its status is in `docs/CITY_UX_NOTES.md` on its branch. See `docs/coordination/LEAD_TASKS.md`.

## 5. Deployment note

* **Deployed.** The owner asked for this work to be on Vercel. The third session deployed the static build of `fd4740d` to the existing project "sweep" on 2026-10-19 (22:56 UTC), with the Vercel CLI logged in inside its container. It is live at https://sweep-ashy.vercel.app, with the city at `/#/workspace`. Landing, lab, city load, Route lab and a coverage plan were checked on the live site, with no console errors.
* To redeploy after changes, follow DEPLOYMENT.md, "Static build on Vercel". A session without a Vercel login cannot deploy: the fourth session's Vercel connector was refused (HTTP 403) for the project's team. Ask the owner first, as before.
* `pnpm build:static` produces `apps/web/dist-static/`. The city JSON is served from `public/cities/`, and `cityUrl()` respects `BASE_URL`.
