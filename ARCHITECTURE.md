# SWEEP: Architecture

This document describes the implementation as it exists now.

```
┌──────────────────────────────── apps/web (React 19 · Vite 7 · TypeScript) ─────────────────────────────────┐
│ Landing (R3F hero) · Workspace (long-form environment, surfaces A–I) · Mathematics · Report · Auth (opt.)  │
│                                                                                                            │
│  state/ (zustand) ── workspace (graph, routing settings, result + fleet, analysis, camera) · prefs · auth  │
│  workspace/useRouteData ── ONE derived model per result: route tracks (by true distance), district,        │
│                            highlight sets, analysis steps → shared by every surface through React context  │
│  A CommandHeader · B SimulationSection (three/DistrictScene) · C ProjectionSection (Canvas2D) ·            │
│  D MathSection · E LabSection · F EditorSection (SVG editor, routing panel, library, import, map dialog) · │
│  G Verification · H History (local) · I Export                                                             │
│  lib/engineClient ─┬─ POST /api/route (authoritative, when the server is reachable)                        │
│                    └─ Web Worker running the same @sweep/engine (offline / static build; lab comparisons)  │
│  lib/maps ─────────── POST /api/maps/acquire · GET /api/maps/geocode (direct Overpass in the static build) │
└───────────────────────────────────────────────┬────────────────────────────────────────────────────────────┘
                                                │ JSON over HTTP (same origin, CSRF token, optional session)
┌──────────────────────────────── apps/server (Node 22 · Hono · node:sqlite) ────────────────────────────────┐
│ secureHeaders (CSP) → body limit → rate limit → CSRF → session → routes                                    │
│ routes: health · examples · validate · optimize · route · import/geojson · maps/{acquire,geocode,status} · │
│         auth · account · scenarios · runs · exports                                                        │
│ solver.ts ── one worker_thread per optimisation, hard timeout (default 20 s)                               │
│ maps.ts   ── Overpass providers in order, error classification, 7-day file cache, Nominatim at 1 req/s     │
│ db.ts     ── SQLite (WAL): users · sessions · scenarios · runs                                             │
│ serves apps/web/dist (production) with SPA fallback                                                        │
└───────────────────────────────────────────────┬────────────────────────────────────────────────────────────┘
                                                │ import
┌──────────────────────────── packages/engine (pure TypeScript, no runtime dependencies) ────────────────────┐
│ undirected: validate · dijkstra · matching/{blossom, dp, greedy} · euler · solve · verify · exhaustive     │
│ directed:   directed (arcs, feasibility, orientation enumeration) · mincostflow · stateSearch · verify     │
│ fleet:      fleet (FHK split + exact split DP, bounds) · verify (verifyFleet) · routing (dispatcher)       │
│ data:       geojson · osm (Overpass → graph) · geo · io (JSON/CSV) · paths · sha256 · examples (+ Zurich)  │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
oracle/ (Python, networkx) ── independent cross-checks (matching, min-cost flow, brute force, state search); tests only
```

## City workspace (`/workspace`, real OpenStreetMap data)

```
data/regions/<id>.json ── bbox, tile size, road classes, Overpass endpoints, focus point
        │  pnpm city:acquire <id>   (scripts/city/acquire.ts)
        │    one request at a time, ≥ 4 s apart, SWEEP User-Agent, 6 attempts with backoff,
        │    endpoint fallback, quadrant split for tiles that keep timing out, checkpoint manifest
        ▼
data/cache/osm/<id>/ ── manifest.json + tiles/<row>_<col>_{streets,buildings}.json (raw Overpass JSON, committed)
        │  pnpm city:build <id>     (scripts/city/build.ts → @sweep/engine city/bundle.ts)
        │    merge + de-duplicate by OSM id · osmToGraph in a local metric frame · way tags kept ·
        │    via-node turn restrictions · footprint validation · heights (tag | levels × 3 m | flagged estimate) ·
        │    provenance (endpoints, OSM database dates, tiles ok/missing, queries, transformations, limitations)
        ▼
apps/web/public/cities/<id>.json + index.json ── format `sweep-city/1`, integer decimetre coordinates
        │  fetch + decodeCityBundle (validates every length and index; CityFormatError otherwise)
        ▼
apps/web/src/city/
  CityWorkspace ── bar (modes: Route lab · Coverage & fleet · Scenarios), camera tools, inspector, legend, provenance
  GeoCityScene (R3F) ── chunked extruded footprints + ribbon roads (meshes built in geometry.worker),
                        theme materials (materials.ts), overlays (routes, search traces, reach, zone, vehicles),
                        picking via SegmentIndex + ground ray (buildings ray-cast on click only)
  router.worker ── RoutingEngine per (profile, scenario): Dijkstra, A*, bidirectional, ALT, CH; validateRoute; reachability
  coverage.worker ── zoneCoverageGraph → solveZoneCoverage → planFleet
  stores (zustand) ── store (city, mode, picks) · routeStore · scenario · coverageStore · shift
  panels ── RouteLab · RouteReport · ScenarioPanel · CoveragePanel · CoverageReport · Timeline
  pure modules ── timeline.ts (deterministic shift clock) · costModel.ts (user-assumption estimates)
```

All routing and coverage computation runs in Web Workers in the browser, on the same bundled data the engine tests use. The city workspace makes no server API calls; the server only serves the static files.

## Component boundaries

| Concern | Where it lives | Notes |
|---|---|---|
| Graph parsing and validation | `engine/validate.ts`, `engine/io.ts`, `server/schemas.ts` | Zod checks shape and size on the server; the engine checks semantics. `onewayPolicy` decides how one-way streets are treated (`reject` / `ignore` / `directed`) |
| Undirected solver | `engine/solve.ts` | Exact Edmonds–Johnson; unchanged algorithm |
| Directed / mixed solver | `engine/directed.ts`, `engine/mincostflow.ts` | Separate module; never uses the undirected matching |
| Independent oracles | `engine/stateSearch.ts`, `engine/exhaustive.ts`, `oracle/` | Share no code with the solvers |
| Fleet planning | `engine/fleet.ts` | Splits a certified single route; reports bound and guarantee |
| Settings dispatch | `engine/routing.ts` (`solveRouting`) | Applies `graph.routing`; the undirected solver is never used for one-way networks without the explicit relaxation |
| Verification | `engine/verify.ts` | `verifyRoute`, `verifyDirectedRoute`, `verifyFleet`: independent of solver internals |
| Map data | `engine/osm.ts`, `engine/geojson.ts`, `server/maps.ts`, `web/lib/maps.ts` | Provenance travels in `graph.source` |
| Persistence | browser `localStorage` (scenarios, experiment log, draft); optional server accounts (`server/db.ts`) | Local-first; no sign-in required for anything |
| Exports | `engine/io.ts` (CSV), `web/lib/exports.ts` (JSON, GeoJSON, report), `server/app.ts` (`/runs/:id/export`) | Every export reads the same record the UI shows |

**One authoritative result.** `runOptimize` sends the graph and its routing settings to `POST /api/route` (or `POST /api/scenarios/:id/runs` for a saved account scenario). The reply is `{ settings, single, fleet, fleetIssues }`. `useRouteData` derives everything that is drawn from it exactly once: the 3D district, lane-offset route tracks parameterised by true route distance, the highlight sets for the selected analysis step, and the analysis steps themselves. Every surface reads that one object, so the city, the projection, the mathematics, the lab, the verification report and the exports cannot disagree. Without a server, the identical engine runs in a Web Worker and the result is labelled "in-browser".

## API

All responses use `{ ok: true, data }` or `{ ok: false, error: { code, message, details? } }`. Every state-changing request needs the `x-csrf-token` header to match the `sweep_csrf` cookie.

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | – | Liveness, engine version, database status |
| `GET /api/auth/csrf` | – | Issues the CSRF cookie |
| `GET /api/examples`, `GET /api/examples/:id` | – | Bundled networks (including the real Zurich sample) |
| `POST /api/validate` | – | `{ graph, depotId? }` → `ValidationReport` |
| `POST /api/optimize` | – | Original contract: undirected solver only → `OptimizationResult` |
| `POST /api/route` | – | `{ graph, depotId?, settings? }` → `RoutingResult` (undirected, directed/mixed, fleet) |
| `POST /api/import/geojson` | – | `{ geojson, name? }` → graph, import report, validation |
| `POST /api/maps/acquire` | – | `{ bbox, roadClasses?, name?, keepAllComponents? }` → `{ graph, report, attempts, cached }` (OSM via Overpass) |
| `GET /api/maps/geocode?q=` | – | Place search via Nominatim (throttled to 1 request/s) |
| `GET /api/maps/status` | – | Whether acquisition is enabled, endpoints, attribution |
| `POST /api/auth/register` · `/login` · `/logout`, `GET /api/auth/me` | – | Optional accounts |
| `PATCH /api/account` · `POST /api/account/password` · `DELETE /api/account` | user | Profile, password change, deletion |
| `GET/POST /api/scenarios`, `GET/PUT/DELETE /api/scenarios/:id`, `POST …/duplicate` | owner | Account scenarios |
| `POST /api/scenarios/:id/runs` | owner | Solve the stored graph with `settings` and store the run |
| `GET /api/scenarios/:id/runs`, `GET /api/runs/:id` | owner | Stored runs (graph snapshot + full routing result) |
| `GET /api/runs/:id/export?format=json\|route.csv\|edges.csv\|fleet.csv` | owner | Downloads |

Requests for another user's resources return **404, not 403**. Runs stored before routing settings existed are read back as undirected single-vehicle results.

## Data model

**Graph** (`engine/types.ts`): vertices (`id`, `x`, `y`, optional `geo`), edges (`id`, `u`, `v`, `weight`, `required`, optional `oneway`, `reverseWeight`, `shape`, `sourceRef`, `roadClass`), `depotId`, `source` (provenance) and `routing` (`mode`, `twoWay`, `ignoreOneway`, `vehicles`, `objective`, `maxRouteLength`). Settings are part of the graph, so they are saved, exported and reopened with the scenario.

**SQLite** (optional accounts): `users`, `sessions` (hashed tokens), `scenarios` (`graph_json`), `runs` (`config_json` with the settings, `graph_json` snapshot, `summary_json`, `record_json` = full routing result).

**Browser storage** (`sweep.*` keys): `localScenarios.v1`, `experiments.v1` (last 40 runs with settings, summary and, when under 350 KB, a graph snapshot), `workspaceDraft.v1`, `autoSolve`, theme and motion preferences, `lastReport.v2`. "Clear local data" removes every `sweep.*` key after confirmation.

## Frontend structure

* **Workspace layout.** A sticky command header (identity, scenario, directions, fleet size, 2D/3D, edit, optimise, mini player, mathematics, export, theme, view menu) over a section nav with a persistent route summary. Below it, the full-bleed simulation (B) and then the analytical surfaces C–I, separated by fine dividers.
* **3D district** (`three/district.ts`, `three/DistrictScene.tsx`). Deterministic from the graph: instanced roads, sidewalks, dashed centre lines, one-way arrows, junction plates (pickable), buildings aligned to their nearest street in several archetypes (gabled houses, setback slabs, L-blocks, podium towers, round towers, old-town blocks for real map data) with a procedural facade shader, and blossom trees. Buildings are context, not data, and the legend says so. Shadows, bloom and vignette drop automatically on slow GPUs (`PerformanceMonitor`). On software rasterisers (SwiftShader, llvmpipe) the scene starts in low-power mode and renders only while playing or interacting; the `sweep.quality` preference overrides this.
* **Spectral route** (`three/materials.ts`). Each route tube vertex carries its true route distance (`aDist`) and traversal kind. The fragment shader draws the colour loop, a travelling light band, a leading highlight at the vehicle and a trail fade as functions of `aDist` against the playback head, so the light follows the computed order without jumps; repeats are striped and deadheads dashed. An additive halo tube and bounded spectral motes (140 points) add atmosphere. Reduced motion freezes the animation and renders on demand.
* **Lanes.** `lib/routeTrack.ts` offsets every traversal to the right of its direction of travel, one lane further out per earlier pass, so repeated passes and the two directions of a two-way street are visible as separate strands in 3D and 2D.
* **Playback.** `workspace/routeClock.ts` is a module-level clock in true route distance; the 3D vehicles, the projection, the ribbon, the deck readouts and the header ring read it directly (no per-frame React renders). Fleet vehicles move at the same speed along their own routes.
* **Projection** (`workspace/RouteProjection.tsx`). Canvas2D with pan, zoom, hover and selection; draws streets, one-way arrows, analysis highlights, the spectral driven trace, repeated and deadhead overlays, traversal order markers, the closed-loop start marker and vehicles. It renders only while visible.
* **Editor** (`workspace/NetworkCanvas.tsx`). SVG with non-scaling strokes; tools for select/move, add, connect, required, one-way (cycle), start, delete; undo/redo; auto-solve after each change.
* **Botanical field.** `PetalSystem` (bounded pools) on one fixed canvas with `pointer-events: none`. Elements can scale it with `data-petal-intensity` (the editor uses 0.2, and nothing is emitted while dragging there). Disabled for reduced motion and touch-first devices.

## Error handling

* Validation issues have stable codes and messages (for example `ONEWAY_REQUIRES_DIRECTED`, `DIRECTED_INFEASIBLE` with the offending streets and a one-click fix, `MIXED_TOO_LARGE`, `FLEET_LIMIT_INFEASIBLE`).
* A failed fleet split keeps the valid single route and explains why (`fleetIssues`).
* Map acquisition reports every provider attempt with a classified error (DNS, TLS, proxy, timeout, rate limit, busy, invalid response) and points to GeoJSON import or the bundled sample.
* API errors map to toasts and inline messages; unhandled server errors return a generic message with a request id.
* Network failure falls back to the in-browser engine; a WebGL failure falls back to the 2D projection.
