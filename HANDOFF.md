# SWEEP: handoff to the next Claude session

This file is written for a Claude Code session that takes over the city-scale redesign of SWEEP. Read it fully before changing anything.

* Read `IMPLEMENTATION_STATUS.md` next. It is the factual record of what has been verified.
* The original product brief is in `PROJECT_BRIEF.md` and `PRD.md`; the earlier engine maths is in `MATHEMATICAL_SPEC.md`.

Snapshot: 2026-10-19, branch `claude/laughing-ramanujan-wg70al`. The commit that adds this file holds all work up to that point.

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

* Pushing to this PR branch is authorized.
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
| `pnpm test` | vitest: engine 154 tests, server 38, web 9 |
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
| `scenario.ts`, `panels/ScenarioPanel.tsx` | scenarios (`closed[]`, `oneway[]`) with real recalculation and a baseline comparison |
| `panels/RouteLab.tsx` | endpoint search that snaps to junctions; profiles; objective; algorithm chips; results rows; agreement banner; replay; reach bands; assumptions |
| `overlays.ts` | route path, search exploration ribbons, reach ribbons, scenario highlights |
| `coverage.worker.ts`, `coverageClient.ts`, `coverageStore.ts` | coverage plans off the main thread: `zoneCoverageGraph` → `solveZoneCoverage` → `planFleet` (when there is more than one vehicle, or a capacity, shift or disposal site is set). Routes come back as arcs. The store holds zone, depot, dump, classes, direction, fleet, result and `resultKey` (a stale flag that includes the scenario key). |
| `panels/CoveragePanel.tsx`, `coverageOverlays.ts` | **done**: the Coverage & fleet panel (rectangle zone drawn with two clicks; depot and disposal picks; road classes; respect or ignore one-ways; fleet inputs; results with method, guarantee, lower bound, gap, per-vehicle table, fleet bounds and checks) and its map layers (one coloured path per vehicle, zone outline, markers) |
| `timeline.ts`, `shift.ts`, `panels/Timeline.tsx` | **done**: the deterministic shift timeline (unit-tested), with shift start, clock, scrubber, fixed-rate playback, per-vehicle street, % done, finish time, over-shift warnings, and vehicle markers on the map |
| `costModel.ts` | **done**: cost and CO₂ estimate from user assumptions only (unit-tested). Shown in the coverage results. |
| `Inspector.tsx`, `Provenance.tsx` | feature details (height source, OSM links) and the data provenance dialog |

### Changes elsewhere in the web app

* The old abstract workspace moved from `/workspace` to `/lab`. Links were updated in Landing, Report, Auth, Account, SiteNav and ReportSections.
* The Velvet materials in the landing `three/CityScene.tsx` and the lab `three/DistrictScene.tsx` were lifted so buildings are visible.

### E2E tests

* `e2e/city.spec.ts`: real-data UI checks against the engine, including:
  * provenance;
  * equivalence of all five algorithms;
  * reachability nesting;
  * a closure clicked on the map triggering a recalculation;
  * measured roof/ground contrast in both themes (must be > 1.3; measured 6.14 in Velvet and 1.52 in Porcelain);
  * the theme switch rebuilding the 3D scene;
  * a building click showing the OSM feature and its height source.
* `e2e/png.ts` decodes screenshots for pixel measurements.
* `e2e/engine.ts` re-exports engine functions for the tests.

---

## 3. Current state (verified numbers; do not restate them without re-measuring)

### Checks that pass

* `pnpm typecheck` ✓.
* `pnpm lint` ✓.
* Engine tests: 154/154 ✓.
* Web tests: 9/9 ✓.

### E2E (last full run: 44 passed, 4 failed)

* `e2e/city.spec.ts` alone: **8/8 pass**.
* The full suite (`npx playwright test`) had 44 passing and **4 failing** tests:
  1. `a11y.spec.ts` › `/workspace (velvet)`: `waitForLoadState('networkidle')` timed out at 90 s.
  2. `auth.spec.ts` › "accounts and persistence … reopen runs … sign out": `toBeVisible`, element not found.
  3. `city.spec.ts` › contrast in the velvet theme: element not found (city-name). It passes alone, so this is probably load- or timeout-related.
  4. `workspace.spec.ts` › "workspace loads … route with real baselines": `locator.click` timed out.

  Failures 2 and 4 are in the old lab, which moved from `/workspace` to `/lab`. Check whether some selector or navigation still assumes `/workspace`, or whether the failure is CPU contention. **Fix these first** (see §4.1).

### Bundled dataset

`apps/web/public/cities/pune-bibwewadi.json` is real but **partial**: it was built from 34 of 85 tile files.

| Item | Value |
|---|---|
| Nodes | 2,636 |
| Segments | 3,103 (203.69 km) |
| One-way segments | 324 |
| Buildings | 6,725 |
| Turn restrictions | 0 (the restriction query had not been fetched) |

The UI shows a "partial" chip and lists the missing tiles in provenance.

### Raw tile cache

The cache is committed under `data/cache/osm/pune-bibwewadi/`. Its manifest had **38 tile files OK and 6 failed** out of 85 (42 tiles × {streets, buildings} + 1 restrictions query). The public Overpass mirrors return many 504/500 errors.

To continue, rerun the acquisition. It resumes from the manifest:

```bash
NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt pnpm city:acquire pune-bibwewadi   # long-running; run in background, log to a file
pnpm city:acquire pune-bibwewadi --status                                                           # progress
pnpm city:build pune-bibwewadi                                                                      # rebuild the bundle once more tiles are ok
```

* The two environment variables are needed in the Claude cloud container, because outbound HTTPS goes through a proxy.
* `overpass-api.de` was unreachable from that environment. `maps.mail.ru` works but is slow.
* Do **not** hammer the servers.

### Verified in the browser

On a car route from Swami Vivekanand Marg to Kamate Nagar Road:

* travel time 10:14 over 4.45 km, with all 5 algorithms agreeing and every route valid;
* the scenario closure moved it to 10:16.

| Algorithm | Arcs settled |
|---|---|
| Dijkstra | 3,513 |
| A* | 1,712 |
| Bidirectional | 1,938 |
| ALT | 434 |
| CH | 44 |

Reachability from the same origin: 22.30 km of street in 5 min, 211.58 km in 10 min, 293.51 km in 15 min.

### Benchmarks

Measured with `pnpm bench` on the partial bundle:

* **P2P, car by time, median per query:** Dijkstra 0.33 ms, A* 0.24 ms, bidirectional 0.13 ms, ALT 0.07 ms, CH 0.05 ms. CH preprocessing takes 227–477 ms.
* **Coverage, full network:** directed exact 368.41 km in 158 ms. The undirected heuristic gives 316.58 km against a lower bound of 296.84 km (gap 6.65 %) in 4.9 s.

### Phase status

| Phase | Status |
|---|---|
| 1 Audit | done |
| 2 Real Pune data | partial; acquisition must finish |
| 3 Renderer and themes | done for the workspace; recapture the same-camera screenshots in both themes for the report |
| 4–6 Routing, profiles, reachability | done and tested |
| 7 Coverage | engine done and tested; Coverage & fleet UI done, with an e2e test against the engine (rectangle zones) |
| 8 Fleet in UI, scenarios for coverage, cost model, report | fleet planning, the cost model, the coverage-vs-baseline comparison and a printable coverage report are done |
| 9 Shift timeline | **done** (coverage plans); e2e-checked against the engine route timed at the set speeds |
| 10 Docs, full verify, final report | **not started** |

---

## 4. What to do next, in order

### 4.1 Make the full e2e suite green

Run `npx playwright test --reporter=line`.

* Inspect each failure with `test-results/<name>/trace.zip`. Unzip it and read `0-trace.trace` and `0-trace.network`, or use `npx playwright show-trace`.
* An "element(s) not found" on `city-name` while the screenshot shows the page usually means the renderer's main thread was starved or blocked.
* Fix the root causes. Do not delete or weaken the tests.

#### What is known about the intermittent city-page freeze

* **Symptom.** Sometimes a `/workspace` page never shows "Pune" in `city-name`. Playwright then reports "element(s) not found" even though the DOM has the element, which means the renderer's main thread is blocked. The trace shows the GeoCityScene and geometry-worker chunk requests issued right after the city JSON arrives, and they never complete.
* **It is not only CPU contention.** It still happened with `workers: 1`.
* **Loading in isolation works.** Six fresh loads in one browser all loaded in about 0.65 s.
* **Mitigations applied so far:**
  * a single WebGL probe per page, released straight away (`lib/webgl.ts`; before, one probe context leaked on every page);
  * Playwright launches with `--enable-unsafe-swiftshader --use-angle=swiftshader`;
  * `workers: 1`.

  Check whether the full suite is now green. If not, open a CDP session on the stuck page and call `Debugger.pause` (bound every CDP call with a timeout). If it pauses, the stack shows the looping JavaScript. If it never pauses, the main thread is stuck in a native or GL call: the SwiftShader GPU process.

### 4.2 Coverage & Fleet UI (the second workflow): mostly done

**Done.** The worker, store, panel and map layers are built, and an e2e test in `e2e/city.spec.ts` ("coverage plan of a drawn zone matches the engine…") checks that the UI totals equal an engine run in directed and undirected mode, with honest method labels.

**Still to do:**

* circle and polygon zones in the UI (the engine already supports them);
* an e2e test for a multi-vehicle fleet with a shift limit, checking that the UI shows the engine's `planFleet` totals and bounds;
* coverage in the scenario comparison (see §4.5).

The original plan for this section is kept below for reference.

**`apps/web/src/city/coverage.worker.ts` (new)**

* Load the city (same approach as `router.worker.ts`: fetch and `decodeCityBundle`).
* Handle the op `{ zone, roadClasses, direction, scenario, depotNode, dumpNode?, fleet: { vehicles, capacity, demandPerKm, shiftSeconds, serviceSpeedKmh, deadheadSpeedKmh, dumpSeconds, objective } }`. It should:
  1. call `zoneCoverageGraph(city, { zone, roadClasses, direction, closedSegments, onewayOverrides, depotId })`, using the vertex id that maps to `depotNode` via `vertexNode`;
  2. call `solveZoneCoverage(graph, { direction, depotId })`;
  3. if vehicles > 1, or capacity or shift is set, call `planFleet(graph, { …, coverage })`;
  4. return the method, `optimal`, `guarantee`, lower bound, gap, connectors, excluded streets, checks, timings, and per-vehicle steps mapped back to segments via `edgeSegment`.
* A `RouteStep` holds an `edgeId`, `from` and `to`; the vertex ids map back to city nodes via `vertexNode`.

**`panels/CoveragePanel.tsx`**

* **Zone tools:** draw a rectangle (two clicks: pick targets `zone-a` and `zone-b`) or a circle (centre plus radius). Show the zone area and the required km from `report`.
* **Depot and dump pick:** pick targets `'depot'` and `'dump'` already map to `pickMode 'node'` in `CityWorkspace.tsx`. Extend `handleCityPick` in `actions.ts`.
* **Road-class checkboxes:** take them from `data/regions/*.json` `roadClasses` and the classes actually present in `city.ways`.
* **Direction mode:**
  * *Respect one-ways (directed)*: exact min-cost flow;
  * *Ignore one-ways (undirected relaxation, for sweepers on foot)*: label it as a relaxation, and show `wrongWayTraversals` counts.
* **Fleet:** vehicles, capacity, shift hours, service and deadhead speeds, dump time, objective (min total / min makespan).
* **Results:**
  * method, and "proven optimal" **only** if `optimal`;
  * otherwise "heuristic", with LB and gap %;
  * total, service and deadhead km;
  * per-vehicle table (distance, time, trips, dumps, feasibility);
  * the validation checks list;
  * timings.

**`coverageOverlays.ts`**

* A coloured path per vehicle: reuse `arcsPath` from `overlays.ts`. The step direction gives the arc: `arc = seg*2 + (from === u ? 0 : 1)`.
* The zone outline (`SceneOverlays.zone`), and depot and dump markers.
* `vehicles` for the timeline.

**E2E tests** in `e2e/city.spec.ts`:

* The UI totals equal an engine run on the same inputs, as the routing tests do.
* Directed mode never says "undirected".
* A heuristic result shows an LB and never says "optimal".
* A closure changes the coverage result against the baseline.

### 4.3 Shift timeline: DONE (kept for reference; consider adding a timeline for multi-vehicle plans to the e2e test)

**`panels/Timeline.tsx`**

* A shift start time, for example 06:00, that the user can configure.
* The clock is derived **deterministically** from fleet routes: for each step, `t += length / speed` (service or deadhead speed), plus dump seconds.
* A scrubber over 0…makespan.
* For each vehicle:
  * current position (interpolate along the step polyline);
  * current segment name;
  * percentage of the route complete;
  * ETA to finish;
  * shift-limit violations, shown in red, using `shiftSeconds`.
* Play/pause runs in real time × a fixed factor. It must not be a set of arbitrary "speed buttons".
* Put the pure timeline maths in `apps/web/src/city/timeline.ts` and unit-test it. Required property: the same input gives the same positions, and they are monotonic in t.

### 4.4 Cost model: DONE (fields start blank; only the 2.68 kg/L diesel factor has a default)

**`apps/web/src/city/costModel.ts`** holds configurable, **visibly labelled assumptions**:

* fuel L/100 km (separately for service and deadhead);
* fuel price ₹/L;
* crew wage ₹/h and crew size;
* diesel CO₂ of 2.68 kg/L, cited as an emission factor and editable.

Rules:

* Output cost, fuel and CO₂ per scenario, always with the label "estimate from your assumptions".
* No default should look like a measured municipal number.
* Unit-test the arithmetic.

### 4.5 Scenarios for coverage: PARTLY DONE

**Done.** The coverage panel has "Compare with baseline", which plans the same zone, depot and fleet on the baseline and on the active scenario (closures and direction changes) and shows distance, transit, makespan and vehicle hours. The e2e test checks both plans against the engine.

**Still to do:** depot, fleet-size, profile and cost-assumption variants stored inside a scenario.

Original plan, for reference:

* Extend `scenario.ts` so a scenario also holds depot, fleet size, profile and cost assumptions.
* Comparing with the baseline must rerun both coverage plans. Show the deltas in km, hours, vehicles and estimated cost and CO₂.

### 4.6 Printable report: DONE for coverage plans (`panels/CoverageReport.tsx`, print CSS in `city.css`; e2e-checked). Still to do: a Route Lab report.

Original plan, for reference:

* Generate it from the **actual** active scenario: dataset provenance, zone, method, guarantee, LB and gap, fleet table, assumptions, validation checks, and the timeline summary.
* The old `apps/web/src/report/Report.tsx` is a pattern to follow, with print CSS.

### 4.7 Docs, verification and final report

**Docs**

* Update `IMPLEMENTATION_STATUS.md` (phase table), `README.md` (run commands, `/workspace`), `ARCHITECTURE.md` (city, p2p, coverage, workers), `TEST_PLAN.md`, `MATHEMATICAL_SPEC.md` (CH/ALT correctness, LB derivations, fleet bounds), `SECURITY.md` (acquisition etiquette, no secrets) and `DEPLOYMENT.md`.

**Verification**

* `pnpm verify` must exit 0.
* Then commit, push to `claude/laughing-ramanujan-wg70al`, and check CI on the PR (`.github/workflows/ci.yml`: `verify` and `docker` jobs).

**Final report**

Write it for the owner, covering:

* files changed;
* the dataset and its extent, and whether it is partial;
* road and building counts;
* theme verification, with same-camera screenshots in both themes;
* the algorithms and their guarantees;
* test results;
* performance measurements;
* Docker and CI status;
* run commands;
* blockers, including the reference repo never received and Overpass availability.

---

## 5. Deployment note

* The owner earlier asked for a Vercel deployment of the static build. That deployment, https://sweep-ashy.vercel.app (project "sweep"), predates the city workspace.
* Do **not** redeploy without the owner's go-ahead.
* `pnpm build:static` produces `apps/web/dist-static/`. The city JSON is served from `public/cities/`, and `cityUrl()` respects `BASE_URL`.
