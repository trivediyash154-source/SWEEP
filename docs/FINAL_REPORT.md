# SWEEP: real city, real routing, real decisions (final report)

* **Status date:** 2026-10-19.
* **Branch:** `claude/peaceful-cray-qmjciz` (draft PR trivediyash154-source/SWEEP#2). It is stacked on `claude/laughing-ramanujan-wg70al` (draft PR trivediyash154-source/SWEEP#1) and contains all of it: two Claude sessions worked on the redesign in parallel, and at the owner's request the first session's branch was merged into the second (`e233ff5`). Two later sessions continued on this branch: the third added several depots, turn-aware order, a faster lower bound and the page-load freeze fix; the fourth fixed the CI failure its last push caused, rebuilt the bundle and refreshed this report. Nothing has been merged into `main`.
* **Evidence:** every number below was measured in this repository on the current code and the 59-tile bundle it ships. The details are in `TEST_PLAN.md`, `IMPLEMENTATION_STATUS.md` and `MATHEMATICAL_SPEC.md`.

## 1. Files changed

The redesign spans 49 commits since `918dac0` (plus two merge commits): 128 files, about 18,400 lines added. That count excludes the raw OSM tile cache and the bundled city file.

* **Data pipeline.**
  * `data/regions/pune-bibwewadi.json` (region definition);
  * `scripts/city/acquire.ts` (polite, resumable Overpass acquisition, with a quadrant fallback, Retry-After and focus-first order);
  * `scripts/city/build.ts` (merge, validate, provenance, bundle);
  * `data/cache/osm/pune-bibwewadi/` (raw tiles and manifest, committed);
  * `apps/web/public/cities/` (the bundle and its index).
* **Engine.**
  * `packages/engine/src/city/`: the bundle format `sweep-city/1`, building heights, ring validation and decoding;
  * `src/geo.ts`: the bundle's local projection and its inverse (`localUnprojection`, used by the GPX export);
  * `src/p2p/`: the turn-expanded routing graph, profiles, Dijkstra, A*, bidirectional search, ALT, CH, the validator and reachability;
  * `src/coverage/`: zone graphs, connectors, lower bounds, the scalable heuristic, zone coverage, multi-vehicle CARP, several depots (`multidepot.ts`), turn-aware order (`turns.ts`) and a sparse assignment solver for the lower bound (`assignment.ts`);
  * `src/mincostflow.ts` and `src/coverage/arcs.ts`: typed-array heaps (same ordering as before, so results are bit-identical);
  * tests in `test/city.test.ts`, `p2p.test.ts`, `p2p.real.test.ts`, `coverage.test.ts`, `assignment.test.ts`, `multidepot.test.ts`, `turns.test.ts` and `priority.test.ts`; benchmarks in `bench/p2p.ts` and `bench/coverage.ts`.

  The exact undirected Chinese Postman solver and all of its tests are unchanged.
* **Web.**
  * `apps/web/src/city/`: the workspace, 3D scene, materials, geometry worker, routing and coverage workers, stores, overlays, timeline, cost model, zone shapes (`zoneShape.ts`), route sheet (`routeSheet.ts`), GPX and CSV exports (`coverageExport.ts`), and panels (Route lab, route report, scenarios with operation changes, coverage & fleet, coverage report, timeline);
  * `styles/city.css`;
  * `components/WebGLBoundary.tsx` around every 3D scene, and `lib/webgl.ts` no longer creates a throwaway probe context (the cause of the intermittent page-load freeze).
  * The old abstract lab moved to `/lab`.
* **Tests and CI.**
  * `e2e/city.spec.ts`: 15 real-data tests, each checked against independent engine runs (routing, reachability, closures, theme contrast in both themes, building identification, rectangle, circle and free-outline zones, fleets with a shift limit, several depots, turn-aware order on and off, a main-roads deadline, scenario comparisons, the route report, GPX and CSV downloads);
  * web unit tests for zone geometry, the route sheet (on 60 real routes), the exports, formats, the cost model and the timeline;
  * `e2e/png.ts`: pixel contrast measurement;
  * Playwright now runs one worker with explicit SwiftShader;
  * the CI job timeout is now 45 min.
* **Docs.**
  * `README`, `ARCHITECTURE`, `MATHEMATICAL_SPEC` (§12–17, references in §18), `SECURITY`, `DEPLOYMENT`, `TEST_PLAN`, `IMPLEMENTATION_STATUS`, `HANDOFF`;
  * screenshots in `docs/screenshots/city-*.png`.

## 2. Dataset and extent

* **Region.** Pune, Bibwewadi and the VIT area. The bounding box is 18.445–18.481 N, 73.850–73.888 E (16.04 km²), cut into 0.006° tiles.
* **Source.** OpenStreetMap through the public Overpass mirror at maps.mail.ru. overpass-api.de was unreachable from the first session's environment, and the other mirrors returned errors.
  * Licence: © OpenStreetMap contributors, ODbL. Attribution is shown in the UI, in both reports and in the GPX export.
  * OSM database state of the downloaded tiles: 2026-06-01 to 2026-10-19.
* **Completeness: partial.**
  * 59 of the 85 tile files (42 tiles × streets and buildings, plus one turn-restriction query) are in the bundle, including the VIT tile.
  * The other 26, including the turn-restriction query, are missing.
    * The public mirror is slow: mostly HTTP 504 or 500, and about 4 tiles an hour at best in the third session.
    * In two of the four sessions the environment's proxy refused every Overpass host (HTTP 403).
  * The UI shows a "partial" chip, and the provenance dialog lists the missing tiles.
  * This is a real extract of part of Pune, not a full map of Pune, and nothing in it is synthetic.

## 3. Road and building counts (bundled extract)

| Item | Count |
|---|---|
| Intersections | 4,753 |
| Street segments | 5,691 (327.39 km), 583 one-way, from 2,906 distinct ways. The import limit is 800,000 and throws an error rather than truncating. |
| Turn restrictions | 0 mapped (the restriction query has not been downloaded yet). Via-way restrictions are unsupported and would be counted, not applied. |
| Building footprints | 12,404: 1 with a `height` tag, 14 from `building:levels` × 3 m, and 12,389 with **estimated** heights. Estimates are flagged; an optional hatch overlay shows them. |
| Footprint validation | 0 rejected; 81 dropped (centroid outside the region); 24 disconnected street fragments (4.25 km) dropped |

## 4. Theme verification

The 3D scene's own materials and lights change with the theme. Verified by e2e:

* switching theme raises the ground luminance at least threefold;
* measured roof-to-ground contrast is 6.86:1 in Velvet and 1.52:1 in Porcelain (threshold 1.3:1), on the 55-tile bundle.

Same-camera captures on the 55-tile bundle: `docs/screenshots/city-velvet.png` and `city-porcelain.png`, plus a route (`city-route-velvet.png`) and a three-vehicle coverage plan mid-shift (`city-coverage-porcelain.png`), all produced by `node scripts/city-screenshots.mjs`. Velvet buildings, which were the original complaint, are clearly visible on the landing page, in the lab and in the city.

## 5. Algorithms

* **Point-to-point routing.** One turn-expanded graph per profile (car, truck, bicycle, foot) and scenario, with two objectives (time with turn penalties; distance). Five algorithms run on that same graph and cost: Dijkstra, A*, bidirectional Dijkstra, ALT (8 landmarks) and contraction hierarchies.
  * Each one reports settled arcs, scanned transitions, median runtime and preprocessing, and replays its real settle order.
  * Reachability bands show 5, 10 and 15 minutes.
  * A printable route report lists the provenance, the query, every algorithm with its independent checks, the profile assumptions and a street-by-street route sheet whose turns come from the engine's own turn classification.
* **Coverage of a drawn zone** (rectangle, circle or free outline; a self-crossing outline is refused):
  * directed (one-way streets obeyed): exact min-cost flow;
  * undirected relaxation: exact Edmonds–Johnson up to 600 odd intersections, otherwise a candidate-matching heuristic.
* **Fleet.** Route-first, cluster-second CARP: an optimal split of the coverage tour under capacity, shift and disposal-site constraints, then deterministic local search. When the limits need more routes than there are vehicles, the UI says so instead of reporting a makespan.
* **Several depots.** Streets go to the depot with the cheapest round trip, then each depot is planned as above. The lower bounds hold for any partition of the streets between depots.
* **Main roads within a deadline.** Trunk to tertiary roads must be serviced within a set time of the shift start. The deadline is a route constraint in the split and the local search, with a two-phase start (main roads split among the vehicles, the other streets appended). On a 400 m zone with 2 vehicles, a 10-minute deadline is met (9.0 min) with a 159-minute shift, against 158.8 min at a 20-minute deadline.
* **Turn-aware order.** The same street traversals in an order with fewer U-turns and right turns (traffic keeps left): an exact pairing of arrivals and departures at each intersection, then sub-tours merged cheapest first. The distance never changes. On a 600 m zone around VIT, with one-way streets respected, turn penalties fell from 229 to 143 min against a lower bound of 132 min, in about 20 ms.
* **Scenarios.** Closures and direction changes, plus per-scenario operation changes (depot, fleet size, shift limit, fuel price and wage). "Compare with baseline" plans both sides and shows the change in distance, hours, vehicles, fuel, CO₂ and cost.
* **Shift timeline.** A deterministic clock replaces the old speed buttons.
* **Cost and CO₂.** Estimated only from rates the user enters, from the routes the vehicles actually drive.
* **Exports.** GPX (one track per vehicle, in driving order) and a CSV step list with street names, OSM way and node ids, direction, and times from the same schedule as the timeline.

## 6. Guarantees (as implemented and stated in the UI)

* **Routing.** All five algorithms are exact for the stated cost model, and the UI states this. They agree to within 1e-9 in tests on synthetic and real networks. An independent validator re-checks every route: endpoints, continuity, permissions, turns, distance, time and cost.
* **Coverage.** "Proven optimal" appears only for an exact method on the unrelaxed problem with no connectors.
  * With connectors (disconnected required streets: the NP-hard Rural Postman case) the result is labelled not proven optimal, with a valid lower bound and the gap.
  * The heuristic never claims optimality.
  * Lower bounds are the T-join bound (exact matching, or the fractional-matching LP dual) for undirected plans, and min-cost flow for directed ones.
* **Fleet.** No optimality is claimed. Valid lower bounds on total distance, makespan and vehicles needed are reported with the gaps, and infeasible plans are reported as infeasible. With several depots the same holds, and the bounds are valid for any split of the streets between depots.
* **Deadline.** Meeting the deadline is checked independently from the street-level steps. The plan reports lower bounds on the main-roads finish time and on the vehicles needed, valid for any plan with the available vehicles; when they prove the deadline impossible, the plan says so instead of claiming it.
* **Turns.** The turn-aware order is a heuristic. Its turn-penalty time is reported with a lower bound that holds for every order of the same traversals; it never claims the fewest possible turns.
* **Not modelled.** Live traffic, legal vehicle dimensions, time-of-day rules and measured fuel. Speeds, turn penalties, fleet parameters and cost rates are labelled assumptions or user inputs.

## 7. Test results

| Suite | Result |
|---|---|
| Typecheck and lint | clean (0 warnings) |
| Engine | 178 / 178 (17 files) |
| Server | 38 / 38 |
| Web | 50 / 50 |
| Python oracle | 661 undirected and 1,401 directed/mixed graphs; all comparisons agree |
| Build (server and static) | passed |
| End-to-end and axe (both themes, desktop and mobile) | 73 / 73 (10.1 min, one worker): 19 on the real Pune data, 6 on the Sweep planner, 4 on Directions |
| Static build in a browser, no API server | landing, lab, city load, Route lab and a coverage plan; no console errors or failed requests |

These are one full `pnpm verify` run on 2026-10-20 on the 59-tile bundle. Test expectations are computed from the bundle, never hard-coded. The intermittent page-load freeze had two causes, both fixed. A throwaway WebGL probe context stalled SwiftShader: 11 stalls in 60 loads before, 0 in 120 after. A Chromium renderer thread-pool deadlock between web-font loading and the 3D scene's script compile: 4–5 in 40 before, 0 in 120 after starting scenes once fonts settle.

## 8. Performance (4-core Xeon at 2.10 GHz, Node 22.22, 59-tile bundle; details in `TEST_PLAN.md` §5)

* **Routing, car, time.** Median per query over 200 seeded random pairs:

  | Algorithm | Median | Preprocessing |
  |---|---:|---:|
  | Dijkstra | 0.53 ms | none |
  | A* | 0.51 ms | none |
  | Bidirectional | 0.26 ms | none |
  | ALT | 0.27 ms | 48 ms |
  | CH | 0.026 ms | 0.74 s |

* **Coverage of the whole extract.**
  * Directed: exact and proven optimal, 622.46 km in 0.24 s. 24 one-way segments cannot be part of a closed route and are excluded.
  * Undirected: heuristic, 499.16 km against a bound of 467.20 km (gap 6.84 %), in 5.6–5.8 s, of which 1.9–2.1 s is the lower bound. The typed-array heaps (20.2 s → 9.4 s on the 47-tile bundle) and the sparse assignment start for the bound (6.0 s → 1.55 s on the 54-tile bundle) brought it here without changing the route; the bound value became slightly stronger.
* **Coverage of an 800 m circle zone.**
  * Directed: exact, 3.89 % gap because 16 connectors were needed, in 0.2 s.
  * 4-vehicle fleet: 3.1–3.4 s.
* **Turn-aware order** of a 600 m zone's route: about 25 ms; 24–122 ms for zones of 300–1,200 m.
* **Frontend.** Frame rates are not reported: this environment rasterises WebGL on the CPU, and scenes start in low-power mode until a hardware GPU is confirmed.

## 9. Docker and CI

* **CI:** GitHub Actions runs `verify` (everything in §7) and `docker` (image build, health check, smoke test, restart persistence, test target). Both were green on `c4ae948`; check the PR for the latest head.
* **Docker:** the image runs as the non-root `node` user, with a health check. No credentials are in the image.

## 10. Run commands

```bash
pnpm install && pnpm build && pnpm start              # → http://localhost:8787/workspace
pnpm dev                                              # web :5173 + API :8787
pnpm verify                                           # typecheck, lint, tests, oracle, build, e2e
pnpm bench                                            # solver benchmarks; city: npx tsx packages/engine/bench/{p2p,coverage}.ts
NODE_USE_ENV_PROXY=1 pnpm city:acquire pune-bibwewadi # resume the OSM download (polite, resumable)
pnpm city:build pune-bibwewadi                        # rebuild the bundle from the cached tiles
node scripts/city-screenshots.mjs                     # docs screenshots (server on :8790)
docker compose up --build
```

## 10b. Real-map pages

* **Directions (`/directions`).**
  * Any place in the world, by car, bicycle or walking, with alternatives and turn-by-turn steps, on a full map.
  * Routes come from the public OSRM servers, which the page names; it never presents them as SWEEP's engine.
* **Sweep planner (`/sweep`).**
  * Draw any real zone up to 25 km². Its streets are downloaded live from OpenStreetMap, in polite tiles above 4 km².
  * SWEEP's exact coverage engine, fleet planner and turn order produce the routes, with the proven lower bound, the gap and the checks.
  * In the tests, the planner's results equal the engine's on real Pune data.

## 11. Blockers and limitations

* **Data.** 26 of 85 tile files, including the restriction query, are still missing.
  * Some environments' proxies refuse every Overpass host (HTTP 403). There the owner must allow one (for example `maps.mail.ru`) in the environment's network settings.
  * Where the mirror is reachable, it is overloaded.
  * The acquisition resumes from its manifest.
* **Building heights.** OSM has height data for 15 of 12,404 footprints, so almost all heights are flagged estimates.
* **Turn restrictions.** None are mapped yet (the restriction query is missing), so banned-turn handling in the turn-aware order is tested on synthetic instances only.
* **Not built.** A per-scenario travel-profile variant, earliest-start windows, and the main-roads deadline with several depots. The coverage solvers do not choose extra deadhead streets to avoid turns; only the order is turn-aware.
* **Reference repository.** The "reverse engineering" repository mentioned at the start was never received (no URL arrived), so it has **not** been reviewed.
* **Deployment: done.** The static build of this version is live at https://sweep-ashy.vercel.app, with the city workspace at https://sweep-ashy.vercel.app/#/workspace. It was deployed on 2026-10-19 from `fd4740d` to the existing Vercel project and checked live: city load, Route lab comparison and coverage plan, with no errors. Accounts and server-side saving need the Node server (Docker), which is not hosted publicly.
