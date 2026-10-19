# SWEEP: real city, real routing, real decisions (final report)

* **Status date:** 2026-10-19.
* **Branch:** `claude/peaceful-cray-qmjciz` (draft PR trivediyash154-source/SWEEP#2). It is stacked on `claude/laughing-ramanujan-wg70al` (draft PR trivediyash154-source/SWEEP#1) and contains all of it: two Claude sessions worked on the redesign in parallel, and at the owner's request the first session's branch was merged into the second (`e233ff5`). Nothing has been merged into `main`.
* **Evidence:** every number below was measured in this repository on the merged code and the bundle it ships. The details are in `TEST_PLAN.md`, `IMPLEMENTATION_STATUS.md` and `MATHEMATICAL_SPEC.md`.

## 1. Files changed

The redesign spans 35 commits since `918dac0` (plus the merge commit): 121 files, about 16,000 lines added. That count excludes the raw OSM tile cache and the bundled city file.

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
  * `src/coverage/`: zone graphs, connectors, lower bounds, the scalable heuristic, zone coverage and multi-vehicle CARP;
  * `src/mincostflow.ts` and `src/coverage/arcs.ts`: typed-array heaps (same ordering as before, so results are bit-identical);
  * tests in `test/city.test.ts`, `p2p.test.ts`, `p2p.real.test.ts` and `coverage.test.ts`; benchmarks in `bench/p2p.ts` and `bench/coverage.ts`.

  The exact undirected Chinese Postman solver and all of its tests are unchanged.
* **Web.**
  * `apps/web/src/city/`: the workspace, 3D scene, materials, geometry worker, routing and coverage workers, stores, overlays, timeline, cost model, zone shapes (`zoneShape.ts`), route sheet (`routeSheet.ts`), GPX and CSV exports (`coverageExport.ts`), and panels (Route lab, route report, scenarios with operation changes, coverage & fleet, coverage report, timeline);
  * `styles/city.css`.
  * The old abstract lab moved to `/lab`.
* **Tests and CI.**
  * `e2e/city.spec.ts`: 12 real-data tests, each checked against independent engine runs (routing, reachability, closures, theme contrast in both themes, building identification, rectangle, circle and free-outline zones, fleets with a shift limit, scenario comparisons, the route report, GPX and CSV downloads);
  * web unit tests for zone geometry, the route sheet (on 60 real routes), the exports, formats, the cost model and the timeline;
  * `e2e/png.ts`: pixel contrast measurement;
  * Playwright now runs one worker with explicit SwiftShader;
  * the CI job timeout is now 45 min.
* **Docs.**
  * `README`, `ARCHITECTURE`, `MATHEMATICAL_SPEC` (§12–14, references in §15), `SECURITY`, `DEPLOYMENT`, `TEST_PLAN`, `IMPLEMENTATION_STATUS`, `HANDOFF`;
  * screenshots in `docs/screenshots/city-*.png`.

## 2. Dataset and extent

* **Region.** Pune, Bibwewadi and the VIT area. The bounding box is 18.445–18.481 N, 73.850–73.888 E (16.04 km²), cut into 0.006° tiles.
* **Source.** OpenStreetMap through the public Overpass mirror at maps.mail.ru. overpass-api.de was unreachable from the first session's environment, and the other mirrors returned errors.
  * Licence: © OpenStreetMap contributors, ODbL. Attribution is shown in the UI, in both reports and in the GPX export.
  * OSM database state of the downloaded tiles: 2026-06-01 to 2026-10-19.
* **Completeness: partial.**
  * 51 of the 85 tile files (42 tiles × streets and buildings, plus one turn-restriction query) are in the bundle, including the VIT tile.
  * The other 34, including the turn-restriction query, are missing. In the first session the public mirror mostly answered HTTP 504/500; in the second, the environment's proxy refused every Overpass host (HTTP 403), so nothing more could be fetched.
  * The UI shows a "partial" chip, and the provenance dialog lists the missing tiles.
  * This is a real extract of part of Pune, not a full map of Pune, and nothing in it is synthetic.

## 3. Road and building counts (bundled extract)

| Item | Count |
|---|---|
| Intersections | 4,160 |
| Street segments | 5,000 (290.97 km), 493 one-way. The round number is a coincidence: 2,512 distinct ways; the import limit is 800,000 and throws an error rather than truncating. |
| Turn restrictions | 0 mapped (the restriction query has not been downloaded yet). Via-way restrictions are unsupported and would be counted, not applied. |
| Building footprints | 11,092: 1 with a `height` tag, 12 from `building:levels` × 3 m, and 11,079 with **estimated** heights. Estimates are flagged; an optional hatch overlay shows them. |
| Footprint validation | 0 rejected; 81 dropped (centroid outside the region); 25 disconnected street fragments (4.54 km) dropped |

## 4. Theme verification

The 3D scene's own materials and lights change with the theme. Verified by e2e:

* switching theme raises the ground luminance at least threefold;
* measured roof-to-ground contrast is 6.86:1 in Velvet and 1.51:1 in Porcelain (threshold 1.3:1), on the 51-tile bundle.

Same-camera captures: `docs/screenshots/city-velvet.png` and `city-porcelain.png`, plus the route captures (`city-route-velvet.png`, `city-route-lab.png`) and the coverage captures (`city-coverage-porcelain.png`, `city-coverage-fleet.png`). Velvet buildings, which were the original complaint, are clearly visible on the landing page, in the lab and in the city.

## 5. Algorithms

* **Point-to-point routing.** One turn-expanded graph per profile (car, truck, bicycle, foot) and scenario, with two objectives (time with turn penalties; distance). Five algorithms run on that same graph and cost: Dijkstra, A*, bidirectional Dijkstra, ALT (8 landmarks) and contraction hierarchies.
  * Each one reports settled arcs, scanned transitions, median runtime and preprocessing, and replays its real settle order.
  * Reachability bands show 5, 10 and 15 minutes.
  * A printable route report lists the provenance, the query, every algorithm with its independent checks, the profile assumptions and a street-by-street route sheet whose turns come from the engine's own turn classification.
* **Coverage of a drawn zone** (rectangle, circle or free outline; a self-crossing outline is refused):
  * directed (one-way streets obeyed): exact min-cost flow;
  * undirected relaxation: exact Edmonds–Johnson up to 600 odd intersections, otherwise a candidate-matching heuristic.
* **Fleet.** Route-first, cluster-second CARP: an optimal split of the coverage tour under capacity, shift and disposal-site constraints, then deterministic local search. When the limits need more routes than there are vehicles, the UI says so instead of reporting a makespan.
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
* **Fleet.** No optimality is claimed. Valid lower bounds on total distance, makespan and vehicles needed are reported with the gaps, and infeasible plans are reported as infeasible.
* **Not modelled.** Live traffic, legal vehicle dimensions, time-of-day rules and measured fuel. Speeds, turn penalties, fleet parameters and cost rates are labelled assumptions or user inputs.

## 7. Test results

| Suite | Result |
|---|---|
| Typecheck and lint | clean (0 warnings) |
| Engine | 156 / 156 |
| Server | 38 / 38 |
| Web | 29 / 29 |
| Python oracle | 661 undirected and 1,401 directed/mixed graphs; all comparisons agree |
| Build | passed |
| End-to-end and axe (both themes, desktop and mobile) | 52 / 52 in a full local run after the merge, and in CI on `e233ff5` |

The last full local `pnpm verify` after the merge (docs-only changes since) exited 0 in 745 s, with 52 of 52 browser tests. Test expectations are computed from the bundle, never hard-coded. The known intermittent page-load freeze (§11) has made single runs fail before; rerun once and read the `freeze-diagnosis` attachment if it does.

## 8. Performance (4-core Xeon at 2.80 GHz, Node 22.22, 51-tile bundle; details in `TEST_PLAN.md` §5)

* **Routing, car, time.** Median per query over 200 seeded random pairs:

  | Algorithm | Median | Preprocessing |
  |---|---:|---:|
  | Dijkstra | 0.46 ms | none |
  | A* | 0.56 ms | none |
  | Bidirectional | 0.29 ms | none |
  | ALT | 0.18 ms | 51 ms |
  | CH | 0.041 ms | 0.71 s |

* **Coverage of the whole extract.**
  * Directed: exact and proven optimal, 547.68 km in 0.3 s (28 one-way segments cannot be part of a closed route and are excluded).
  * Undirected: heuristic, 445.67 km against a bound of 419.08 km (gap 6.35 %), in 9.0 s, 6.1 s of it the lower bound. Before the typed-array heaps it took about twice as long with an identical result (20.2 s → 9.4 s on the 47-tile bundle).
* **Coverage of an 800 m circle zone.**
  * Directed: exact, 4.24 % gap because 10 connectors were needed, in 0.2 s.
  * 4-vehicle fleet: 3.2 s.
* **Frontend.** Frame rates are not reported: this environment rasterises WebGL on the CPU, and the app detects that and switches to low-power rendering.

## 9. Docker and CI

* **CI:** GitHub Actions runs `verify` (everything in §7) and `docker` (image build, health check, smoke test, restart persistence, test target). Both were green on the merge commit `e233ff5`; check the PR for the latest head.
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

## 11. Blockers and limitations

* **Data.** 34 of 85 tile files, including the restriction query, are still missing. The environment's proxy currently refuses every Overpass host (HTTP 403); the owner must allow one (for example `maps.mail.ru`) in the environment's network settings. The acquisition then resumes from its manifest.
* **Building heights.** OSM has height data for 13 of 11,092 footprints, so almost all heights are flagged estimates.
* **Intermittent page-load freeze.** About 1 page load in 200 in the test runs stops at "Loading city…". It is not fixed; the city e2e tests now attach a debugger stack when it happens (`HANDOFF.md` §4.1).
* **Not built.** A per-scenario travel-profile variant, coverage with time windows or turn costs, and several depots in one plan.
* **Reference repository.** The "reverse engineering" repository mentioned at the start was never received (no URL arrived), so it has **not** been reviewed.
* **Deployment.** The Vercel deployment (https://sweep-ashy.vercel.app) is an earlier static build without the city workspace. It has not been redeployed, because that needs the owner's go-ahead.
