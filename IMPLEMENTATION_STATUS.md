# SWEEP: Implementation Status (city-scale redesign)

This is a living record of the city-scale redesign: what exists, what was verified, and what remains. Entries are factual. A feature is listed as done only after it has been implemented and tested.

## Phase 1: Baseline audit (2026-10-19)

### Repository

| Item | State |
|---|---|
| Branch | `claude/laughing-ramanujan-wg70al` (PR trivediyash154-source/SWEEP#1, draft) |
| Baseline commit | `918dac0` |
| Working tree at audit | clean |
| CI on `918dac0` | all 4 jobs green (`verify` ×2, `docker` ×2) |
| Local `pnpm verify` on `918dac0` | exit 0. Typecheck and lint passed; engine 96/96, server 38/38, web 7/7; oracle 661 undirected and 1,401 directed/mixed graphs, all agree; build passed; Playwright 37/37 |
| Unit tests re-run at audit | engine 96/96, server 38/38, web 7/7; both oracle runs agree |

### Architecture found

* **Engine** (`packages/engine/src`):
  * undirected CPP: `solve.ts` (Edmonds–Johnson, blossom matching with an LP certificate; exact up to 600 odd vertices);
  * directed/mixed CPP: `directed.ts`, `mincostflow.ts`;
  * fleet splitting: `fleet.ts` (FHK split plus an exact split DP);
  * independent checks: `verify.ts`, `stateSearch.ts`, `exhaustive.ts`;
  * maps: OSM conversion in `osm.ts`, GeoJSON in `geojson.ts`;
  * bundled examples, including the real Zurich extract.
* **Graph model.** `Graph` holds vertices and edges with `u`, `v`, `weight`, `required`, and optional `oneway`, `reverseWeight`, `shape`, `geo` and `roadClass`.
  * Loops, parallel edges and zero weights are allowed.
  * The undirected solver refuses one-way edges unless the relaxation is explicit.
  * Required edges must be connected; otherwise the graph is refused (`REQUIRED_DISCONNECTED`).
  * The undirected solver has no notion of travel time.
* **Renderer** (`apps/web/src/three/DistrictScene.tsx`, `district.ts`):
  * buildings are **procedural**, generated around any graph;
  * the spectral route shader is driven by route distance.
  * In Velvet the building and ground materials are near-black and nearly invisible; the same problem exists in the landing `HeroScene`.
* **Playback.** `routeClock.ts` advances in route distance, and `PlaybackDeck` offers 0.5–8× speed buttons. Nothing about it is in clock time.
* **Map import.** `MapAcquireDialog` → `/api/maps/acquire`, which is Overpass with provider fallback and capped at 4 km². It fetches streets only, no buildings.

### Map download (verified, not assumed)

* **Process.** `scratchpad/bin/fetch_city.sh` (pid alive at audit) queries `maps.mail.ru/osm/tools/overpass` in 0.006° tiles, with a SWEEP User-Agent, a 4 s pause between requests, up to 5 retries with 15–75 s backoff, and resumption by skipping tiles already saved.
* **Area.** The bbox is 18.445–18.481 N, 73.850–73.888 E: about 4.0 × 4.0 km around VIT Bibwewadi. That is 6 rows × 7 columns = 42 tiles, each queried for streets and for buildings.
* **Progress at audit.** 21 of 84 tile files had been saved (2.9 MB, rows 0–1). 34 retries were needed, all for HTTP 504 (the mirror is under load); every tile eventually succeeded.
* **Content checked:**
  * 950 street ways and 3,716 nodes;
  * highway classes: residential 676, service 168, trunk 55, tertiary 31, living_street 11, trunk_link 6, primary 3;
  * tag coverage: `name` 109, `oneway` 111, `maxspeed` 34, `access` 176, `surface` 15, `lanes` 24;
  * 4,688 building footprints, all closed rings with at least 4 points.
* **Building heights.** Height data is almost absent: 7 buildings have `building:levels` and 1 has `height`. Almost every height will therefore be a documented estimate, and is flagged as such in the data model.
* **Other sources.** `overpass-api.de` was unreachable from this environment (connection closed). `overpass.private.coffee` and `overpass.kumi.systems` returned 500. Geofabrik was unreachable. Nominatim and the OSM tile server were reachable.

## Implementation sequence

| Phase | Scope | Status |
|---|---|---|
| 1 | Audit and baseline | done |
| 2 | Pune data: tiled acquisition, merge, validation, provenance, bundled offline dataset | partial: the pipeline is done and tested. The bundle is built from 59 of 85 tile files (4,753 nodes, 5,691 segments over 327.39 km, 12,404 buildings). The acquisition only progresses in an environment whose network policy allows an Overpass mirror: the second and fourth sessions' proxies refused them (HTTP 403); the third session could reach `maps.mail.ru`, which mostly answered 504 (see `HANDOFF.md` §3) |
| 3 | Real geographic renderer; Velvet and Porcelain materials | done in `/workspace`. Measured roof/ground contrast is 6.86:1 in Velvet and 1.52:1 in Porcelain (e2e, on the 55-tile bundle). The intermittent page-load freeze (a throwaway WebGL probe context stalling SwiftShader) was found and fixed in the third session. The landing page and lab Velvet materials were lifted. |
| 4 | Point-to-point Dijkstra and A* with validation and a recorded search trace | done and tested (engine and e2e) |
| 5 | Bidirectional search, ALT and Contraction Hierarchies, with equivalence tests | done and tested. All 5 algorithms agree to 1e-9 on the real network. |
| 6 | Travel-time profiles, restrictions, reachability | done and tested: car, truck, bicycle and foot profiles; turn penalties; via-node restrictions; 5/10/15-minute reachability nests |
| 7 | Coverage on real extracts: exact, directed, scalable heuristic with lower bound, multi-vehicle | done and tested: engine (21 tests) and the Coverage & fleet workspace with rectangle, circle and polygon zones; each zone shape is checked against an engine run in the browser tests. Turn-aware order of the same traversals (fewer U-turns and right turns at the same distance, with a lower bound on turn penalties) and a 3.9× faster whole-network lower bound (sparse assignment start) were added in the third session |
| 8 | Fleet planning, scenarios, shift timeline, report | done and tested: multi-vehicle plans (equal to `planFleet` in the browser test, with an honest diagnosis when the limits need more vehicles than available), the shift timeline, the cost model (applied to the routes actually driven), scenario plan overrides (depot, vehicles, shift, cost assumptions) compared with the baseline, and printable coverage and Route lab reports. Several depots in one plan (`planMultiDepotFleet`, bounds valid for any partition) were added in the third session, and a main-roads deadline (latest finish after the shift start, with bounds on the finish time and the vehicles needed; one depot) in the fourth. Both are checked against the engine in the browser tests |
| 9 | Full test suite, browser inspection of both themes, performance measurements | Engine 178/178, server 38/38, web 50/50, both oracles agree, e2e 73/73 (2026-10-20, 59-tile bundle). Benchmarks re-run on the 55-tile bundle (`TEST_PLAN.md` §5). The static build was checked in a browser from a plain file server: city load, Route lab and a coverage plan, with no console errors. |
| 9b | Real-map pages: Directions anywhere (public OSRM, named) and a Sweep planner for any real zone up to 25 km² (live OSM download, SWEEP's exact engine) | done and tested: unit tests against the engine on a real cached Pune Overpass response, e2e with stand-in services in their real formats; not yet exercised against the live services from the container (its network policy denied them) |
| 10 | Documentation | updated: README, ARCHITECTURE (city workspace), MATHEMATICAL_SPEC §12–17 (routing, coverage bounds, fleet bounds, several depots, turns, priority deadline), SECURITY (acquisition etiquette, city inputs), this file and `HANDOFF.md`. The final report to the owner is `docs/FINAL_REPORT.md`. |

## Reference repository

You mentioned a "reverse engineering" reference repository, but no URL arrived in any message. **It has not been reviewed.** Paste the link to have it reviewed.
