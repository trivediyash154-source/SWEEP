# SWEEP: Architecture

This document describes the implementation as it exists now.

```
┌─────────────────────────────── apps/web (React 19 · Vite 7 · TypeScript) ───────────────────────────────┐
│ Landing (R3F hero, botanical field, scroll story) · Workspace · Mathematics · Auth · Account · Report    │
│                                                                                                          │
│  state/ (zustand)  ── workspace · auth · prefs · toasts                                                  │
│  workspace/        ── NetworkCanvas (SVG editor) · NetworkLayers · Inspector · Results · Explain ·       │
│                       Playback · Library · Import · Route3D                                              │
│  three/            ── cityModel (pure scene model) · CityScene (instancing, tube, bloom) · HeroScene     │
│  lib/engineClient ─┬─ POST /api/optimize (authoritative, when the server is reachable)                   │
│                    └─ Web Worker running the same @sweep/engine (static build / offline fallback)        │
└───────────────────────────────────────────────┬──────────────────────────────────────────────────────────┘
                                                │ JSON over HTTP (same origin, CSRF token, session cookie)
┌───────────────────────────────── apps/server (Node 22 · Hono · node:sqlite) ─────────────────────────────┐
│ secureHeaders (CSP) → body limit → rate limit → CSRF → session → routes                                  │
│ routes: health · examples · validate · optimize · import/geojson · auth · account · scenarios · runs ·   │
│         exports                                                                                          │
│ solver.ts ── one worker_thread per optimisation, hard timeout (default 20 s)                             │
│ db.ts     ── SQLite (WAL): users · sessions · scenarios · runs                                           │
│ serves apps/web/dist (production) with SPA fallback                                                      │
└───────────────────────────────────────────────┬──────────────────────────────────────────────────────────┘
                                                │ import
┌──────────────────────────── packages/engine (pure TypeScript, no runtime dependencies) ──────────────────┐
│ types · validate · graph (index, union-find) · dijkstra · matching/{blossom, dp, greedy} · euler ·       │
│ solve · verify · exhaustive (tests) · geojson · io (JSON/CSV) · sha256 · examples                        │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
oracle/ (Python, networkx) ── independent cross-check used only by the test suite
```

## Component boundaries

| Concern | Where it lives | Notes |
|---|---|---|
| Graph parsing and validation | `engine/validate.ts`, `engine/io.ts`, `server/schemas.ts` | The server checks shape and size with Zod; the engine checks semantics |
| Algorithms | `engine/dijkstra.ts`, `engine/matching/*`, `engine/euler.ts` | Pure functions with no I/O |
| Optimisation orchestration | `engine/solve.ts` | Produces the `OptimizationRecord` |
| Result verification | `engine/verify.ts` | Independent of the solver internals |
| Persistence | `server/db.ts`, `server/app.ts` | Owner-scoped SQL on every query |
| Authentication | `server/security.ts`, `server/app.ts` | scrypt, hashed session tokens, CSRF, rate limits |
| Export generation | `engine/io.ts` (CSV), `server/app.ts` (`/runs/:id/export`), `web/report` (print) | Every export reads the same engine record |
| Request handling | `server/app.ts` | One consistent response envelope for every endpoint |

**The authoritative result.** When the server is reachable, the browser sends the graph to `POST /api/optimize`, or to `POST /api/scenarios/:id/runs` for a saved account scenario. All metrics shown in the UI come from the returned record. The browser never recomputes totals. The static, serverless build runs the identical engine package in a Web Worker and labels the result "in-browser".

## API

All responses use the shape `{ ok: true, data }` or `{ ok: false, error: { code, message, details? } }`. Every state-changing request needs the `x-csrf-token` header to match the `sweep_csrf` cookie.

| Method and path | Auth | Purpose |
|---|---|---|
| `GET /api/health` | – | Liveness, engine version, database status |
| `GET /api/auth/csrf` | – | Issues the CSRF cookie |
| `GET /api/examples`, `GET /api/examples/:id` | – | Bundled networks |
| `POST /api/validate` | – | `{ graph, depotId? }` → `ValidationReport` |
| `POST /api/optimize` | – | `{ graph, depotId? }` → `OptimizationResult` (computed in a worker thread) |
| `POST /api/import/geojson` | – | `{ geojson, name? }` → graph, import report and validation |
| `POST /api/auth/register` · `/login` · `/logout` | – | Sessions |
| `GET /api/auth/me` | optional | Current user, or null |
| `PATCH /api/account` · `POST /api/account/password` · `DELETE /api/account` | user | Profile, password change (revokes other sessions), account deletion |
| `GET/POST /api/scenarios` | user | List and create |
| `GET/PUT/DELETE /api/scenarios/:id` | owner | Read, update (name and/or graph), delete |
| `POST /api/scenarios/:id/duplicate` | owner | Copy |
| `POST /api/scenarios/:id/runs` | owner | Optimise the stored graph and store the run |
| `GET /api/scenarios/:id/runs` | owner | Run history (latest 50) |
| `GET /api/runs/:id` | owner | Stored record together with its graph snapshot |
| `GET /api/runs/:id/export?format=json\|route.csv\|edges.csv` | owner | Downloads |

Requests for another user's resources return **404, not 403**, so that the existence of their ids is not confirmed.

## Data model (SQLite)

| Table | Columns |
|---|---|
| `users` | `id`, `email` (unique, lower-cased), `display_name`, `password_hash` (`scrypt$N$r$p$salt$hash`), `created_at` |
| `sessions` | `token_hash` (SHA-256 of a 256-bit random token), `user_id`, `created_at`, `expires_at` |
| `scenarios` | `id`, `owner_id`, `name`, `graph_json`, `created_at`, `updated_at` |
| `runs` | `id`, `scenario_id`, `owner_id`, `engine_version`, `graph_hash`, `config_json` (depot), `graph_json` (snapshot), `summary_json`, `record_json`, `created_at` |

A run stores everything needed to reproduce it: the graph snapshot, configuration, engine version and input hash. The engine is deterministic and does not use randomness.

## Frontend structure

* **Routing:** `BrowserRouter` for the server build and `HashRouter` for the static build (`VITE_STATIC=1`). Routes are lazy-loaded; the 3D code (three.js, R3F, postprocessing; about 264 KB gzip) loads only on the landing hero and in the 3D route view.
* **2D canvas:** a single SVG. Strokes use `vector-effect: non-scaling-stroke` and radii are divided by the zoom factor, so marks keep a constant on-screen size. Overlays have `pointer-events: none`. The route animation reads a module-level `routeClock`, outside React, and writes `transform` and `stroke-dashoffset` directly, so there are no per-frame React renders.
* **3D:** `buildCityModel` turns the same graph and record into road segments (instanced boxes), buildings (instanced, placed by sampling free space away from every road), junctions and a route polyline. `CityScene` draws the route as a `TubeGeometry` whose `drawRange` follows progress, with a vehicle placed by `sampleRoute`, which is the same function the 2D view uses. `PerformanceMonitor` drops the DPR and post-processing on slow devices. Without WebGL, an SVG fallback is shown.
* **Botanical field:** `PetalSystem` is a pure simulation with bounded pools and distance-based emission. `BotanicalCursorField` renders it on one fixed canvas with `pointer-events: none`, pre-rendered sprites, and a rAF loop that sleeps when idle. It is disabled for reduced motion and for coarse pointers.

## Error handling

* Engine validation issues have stable codes, a severity and human messages, and are shown in the Diagnostics panel.
* API errors map to toasts and inline messages. Unhandled server errors return a generic message with a request id; details are logged server-side and never sent to the client.
* Network failure falls back to the in-browser engine.
* A WebGL failure falls back to the SVG view.
