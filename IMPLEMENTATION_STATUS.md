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
| 2 | Pune data: tiled acquisition, merge, validation, provenance, bundled offline dataset | partial: the pipeline is done and tested. The bundle is built from 47 of 85 tile files (3,776 nodes, 4,517 segments over 267.2 km, 10,412 buildings). In the second session the environment's proxy refused every Overpass mirror (HTTP 403), so the acquisition could not continue (see `HANDOFF.md` §3) |
| 3 | Real geographic renderer; Velvet and Porcelain materials | done in `/workspace`. Measured roof/ground contrast is 6.14:1 in Velvet and 1.52:1 in Porcelain (e2e). The landing page and lab Velvet materials were lifted. |
| 4 | Point-to-point Dijkstra and A* with validation and a recorded search trace | done and tested (engine and e2e) |
| 5 | Bidirectional search, ALT and Contraction Hierarchies, with equivalence tests | done and tested. All 5 algorithms agree to 1e-9 on the real network. |
| 6 | Travel-time profiles, restrictions, reachability | done and tested: car, truck, bicycle and foot profiles; turn penalties; via-node restrictions; 5/10/15-minute reachability nests |
| 7 | Coverage on real extracts: exact, directed, scalable heuristic with lower bound, multi-vehicle | done and tested: engine (21 tests) and the Coverage & fleet workspace with rectangle, circle and polygon zones; each zone shape is checked against an engine run in the browser tests |
| 8 | Fleet planning, scenarios, shift timeline, report | done and tested: multi-vehicle plans (equal to `planFleet` in the browser test, with an honest diagnosis when the limits need more vehicles than available), the shift timeline, the cost model (applied to the routes actually driven), scenario plan overrides (depot, vehicles, shift, cost assumptions) compared with the baseline, and printable coverage and Route lab reports |
| 9 | Full test suite, browser inspection of both themes, performance measurements | Engine 154/154, server 38/38, web 26/26, e2e 51/51 (second session). Benchmarks were measured on the earlier 34-tile bundle and must be re-run. |
| 10 | Documentation | updated: README, ARCHITECTURE (city workspace), MATHEMATICAL_SPEC §12–14 (routing, coverage bounds, fleet bounds), SECURITY (acquisition etiquette, city inputs), this file and `HANDOFF.md`. The final report to the owner is still to write. |

## Reference repository

You mentioned a "reverse engineering" reference repository, but no URL arrived in any message. **It has not been reviewed.** Paste the link to have it reviewed.
