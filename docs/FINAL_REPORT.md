# SWEEP: real city, real routing, real decisions (final report)

* **Status date:** 2026-10-19.
* **Branch:** `claude/laughing-ramanujan-wg70al` (draft PR trivediyash154-source/SWEEP#1, not merged).
* **Evidence:** every number below was measured in this repository. The details are in `TEST_PLAN.md`, `IMPLEMENTATION_STATUS.md` and `MATHEMATICAL_SPEC.md`.

## 1. Files changed

The redesign spans 28 commits since `918dac0`: 108 files, about 14,600 lines added. That count excludes the raw OSM tile cache and the bundled city file.

* **Data pipeline.**
  * `data/regions/pune-bibwewadi.json` (region definition);
  * `scripts/city/acquire.ts` (polite, resumable Overpass acquisition, with a quadrant fallback, Retry-After and focus-first order);
  * `scripts/city/build.ts` (merge, validate, provenance, bundle);
  * `data/cache/osm/pune-bibwewadi/` (raw tiles and manifest, committed);
  * `apps/web/public/cities/` (the bundle and its index).
* **Engine.**
  * `packages/engine/src/city/`: the bundle format `sweep-city/1`, building heights, ring validation and decoding;
  * `src/p2p/`: the turn-expanded routing graph, profiles, Dijkstra, A*, bidirectional search, ALT, CH, the validator and reachability;
  * `src/coverage/`: zone graphs, connectors, lower bounds, the scalable heuristic, zone coverage and multi-vehicle CARP;
  * tests in `test/city.test.ts`, `p2p.test.ts`, `p2p.real.test.ts` and `coverage.test.ts`; benchmarks in `bench/p2p.ts` and `bench/coverage.ts`.

  The exact undirected Chinese Postman solver and all of its tests are unchanged.
* **Web.**
  * `apps/web/src/city/`: the workspace, 3D scene, materials, geometry worker, routing and coverage workers, stores, overlays, timeline, cost model, and panels (Route lab, route report, scenarios, coverage & fleet, coverage report, timeline);
  * `styles/city.css`.
  * The old abstract lab moved to `/lab`.
* **Tests and CI.**
  * `e2e/city.spec.ts`: 10 real-data tests, each checked against independent engine runs;
  * `e2e/png.ts`: pixel contrast measurement;
  * Playwright now runs one worker with explicit SwiftShader;
  * the CI job timeout is now 45 min.
* **Docs.**
  * `README`, `ARCHITECTURE`, `MATHEMATICAL_SPEC` (§12–16), `SECURITY`, `DEPLOYMENT`, `TEST_PLAN`, `IMPLEMENTATION_STATUS`, `HANDOFF`;
  * screenshots in `docs/screenshots/city-*.png`.

## 2. Dataset and extent

* **Region.** Pune, Bibwewadi and the VIT area. The bounding box is 18.445–18.481 N, 73.850–73.888 E (16.04 km²), cut into 0.006° tiles.
* **Source.** OpenStreetMap through the public Overpass mirror at maps.mail.ru. overpass-api.de was unreachable from this environment, and the other mirrors returned errors.
  * Licence: © OpenStreetMap contributors, ODbL. Attribution is shown in the UI and in both reports.
  * OSM database state of the downloaded tiles: 2026-06-01 to 2026-10-19.
* **Completeness: partial.**
  * 50 of 85 tile downloads are in the bundle, including the VIT tile.
  * The other 35 (and the turn-restriction query) were still being downloaded. The public mirror mostly answers HTTP 504/500.
  * The UI shows a "partial" chip, and the provenance dialog lists the missing tiles.
  * This is a real extract of part of Pune, not a full map of Pune, and nothing in it is synthetic.

## 3. Road and building counts (bundled extract)

| Item | Count |
|---|---|
| Intersections | 4,160 |
| Street segments | 5,000 (290.97 km), 493 one-way. The round number is a coincidence: 2,512 distinct ways; the import limit is 800,000 and throws an error rather than truncating. |
| Turn restrictions | 0 mapped (the restriction query has not been downloaded yet). Via-way restrictions are unsupported and would be counted, not applied. |
| Building footprints | 10,704: 1 with a `height` tag, 11 from `building:levels` × 3 m, and 10,692 with **estimated** heights. Estimates are flagged; an optional hatch overlay shows them. |
| Footprint validation | 0 rejected; 81 dropped (centroid outside the region); 25 disconnected street fragments (4.54 km) dropped |

## 4. Theme verification

The 3D scene's own materials and lights change with the theme. Verified by e2e:

* switching theme raises the ground luminance at least threefold;
* measured roof-to-ground contrast is 6.14:1 in Velvet and 1.52:1 in Porcelain (threshold 1.3:1).

Same-camera captures: `docs/screenshots/city-velvet.png` and `city-porcelain.png`, plus the route capture in Velvet and the coverage capture in Porcelain. Velvet buildings, which were the original complaint, are clearly visible on the landing page, in the lab and in the city.

## 5. Algorithms

* **Point-to-point routing.** One turn-expanded graph per profile (car, truck, bicycle, foot) and scenario, with two objectives (time with turn penalties; distance). Five algorithms run on that same graph and cost: Dijkstra, A*, bidirectional Dijkstra, ALT (8 landmarks) and contraction hierarchies.
  * Each one reports settled arcs, scanned transitions, median runtime and preprocessing, and replays its real settle order.
  * Reachability bands show 5, 10 and 15 minutes.
* **Coverage of a drawn zone** (rectangle or circle; the engine also accepts polygons):
  * directed (one-way streets obeyed): exact min-cost flow;
  * undirected relaxation: exact Edmonds–Johnson up to 600 odd intersections, otherwise a candidate-matching heuristic.
* **Fleet.** Route-first, cluster-second CARP: an optimal split of the coverage tour under capacity, shift and disposal-site constraints, then deterministic local search.
* **Scenarios.** Closures, direction changes, and another depot or fleet size are all recomputed against the baseline.
* **Shift timeline.** A deterministic clock replaces the old speed buttons.
* **Cost and CO₂.** Estimated only from rates the user enters.

## 6. Guarantees (as implemented and stated in the UI)

* **Routing.** All five algorithms are exact for the stated cost model, and the UI states this. They agree to within 1e-9 in tests on synthetic and real networks. An independent validator re-checks every route: endpoints, continuity, permissions, turns, distance, time and cost.
* **Coverage.** "Proven optimal" appears only for an exact method on the unrelaxed problem with no connectors.
  * With connectors (disconnected required streets: the NP-hard Rural Postman case) the result is labelled not proven optimal, with a valid lower bound and the gap.
  * The heuristic never claims optimality.
  * Lower bounds are the T-join bound (exact matching, or the fractional-matching LP dual) for undirected plans, and min-cost flow for directed ones.
* **Fleet.** No optimality is claimed. Valid lower bounds on total distance, makespan and vehicles needed are reported with the gaps, and infeasible plans are reported as infeasible.
* **Not modelled.** Live traffic, legal vehicle dimensions, time-of-day rules and measured fuel. Speeds, turn penalties, fleet parameters and cost rates are labelled assumptions or user inputs.

## 7. Test results (last full `pnpm verify`: exit 0, 562 s)

| Suite | Result |
|---|---|
| Typecheck and lint | clean (0 warnings) |
| Engine | 154 / 154 |
| Server | 38 / 38 |
| Web | 16 / 16 |
| Python oracle | 661 undirected and 1,401 directed/mixed graphs; all comparisons agree |
| Build | passed |
| End-to-end and axe (both themes, desktop and mobile) | 50 / 50 |

After the bundle was rebuilt from 50 tiles, the engine suite (154 / 154) and the city, accessibility and responsive e2e suites (25 / 25) pass again on the new data. Test expectations are computed from the bundle, never hard-coded.

## 8. Performance (4-core Xeon at 2.10 GHz, Node 22; details in `TEST_PLAN.md` §5)

* **Routing, car, time.** Median per query over 200 seeded random pairs:

  | Algorithm | Median | Preprocessing |
  |---|---:|---:|
  | Dijkstra | 0.45 ms | none |
  | A* | 0.47 ms | none |
  | Bidirectional | 0.27 ms | none |
  | ALT | 0.12 ms | 53 ms |
  | CH | 0.029 ms | 0.67 s |

* **Coverage of the whole extract.**
  * Directed: exact and proven optimal, 547.68 km in 197 ms.
  * Undirected: heuristic, 445.67 km against a bound of 419.08 km (gap 6.35 %), in 12.3 s.
* **Coverage of an 800 m zone.**
  * Directed: exact, 4.24 % gap because 10 connectors were needed, in 144 ms.
  * 4-vehicle fleet: 3.7 s.
* **Frontend.** Frame rates are not reported: this environment rasterises WebGL on the CPU, and the app detects that and switches to low-power rendering.

## 9. Docker and CI

* **CI:** GitHub Actions runs `verify` (everything in §7) and `docker` (image build, health check, smoke test, restart persistence, test target). It was green on `17f7e22` and on later commits; check the PR for the latest head.
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

* **Data.** 35 of 85 tile downloads and the restriction query are still missing. The public Overpass mirrors are failing (HTTP 504/500 or timeouts); the acquisition resumes from its manifest.
* **Building heights.** OSM has height data for 12 of 10,704 footprints, so almost all heights are flagged estimates.
* **Not built.** Polygon zones in the UI (the engine supports them), and a per-scenario travel-profile variant.
* **Reference repository.** The "reverse engineering" repository mentioned at the start was never received (no URL arrived), so it has **not** been reviewed.
* **Deployment.** The Vercel deployment (https://sweep-ashy.vercel.app) is an earlier static build without the city workspace. It has not been redeployed, because that needs the owner's go-ahead. Nothing has been merged.
