# SWEEP: Task Tracker

Status key: ✅ done and verified · ⚠️ done with a documented limitation · ❌ not done

## Milestone 1: Environment and mathematical core ✅
- ✅ Inspected the environment: Node 22.22, pnpm 10.28, Python 3.13, Chromium 141 for Playwright, npm and PyPI reachable, OSM Overpass, drand and OEIS blocked
- ✅ pnpm workspace (engine, server, web)
- ✅ Typed graph model and validation with stable issue codes
- ✅ Dijkstra; Edmonds blossom with certificate; subset-DP cross-check; greedy baseline; Hierholzer
- ✅ Rural-postman extension (connected required set); connector suggestions
- ✅ Independent route verifier; exhaustive reference solver
- ✅ 10 bundled examples covering all required cases
- ✅ Vitest + fast-check suite (36 tests); Python networkx oracle (660 graphs)
- ✅ Benchmarks; limit set to 600 odd vertices from measurements

## Milestone 2: Functional workspace ✅
- ✅ SVG editor: add, move, connect, delete, rename, re-weight, required toggle, start, undo and redo, pan and zoom, keyboard table
- ✅ Example library, live diagnostics, optimise (server, or worker fallback)
- ✅ Results: totals, baselines, verification checks, assumptions, engine metadata, staleness
- ✅ Explain mode (7 steps from the real record) and route playback

## Milestone 3: Premium interface ✅
- ✅ Design tokens; Velvet and Porcelain themes; typography; motion system
- ✅ Landing: hero, instrument readout, scroll sections A–F with live figures
- ✅ BotanicalCursorField with bloom; spectral signature
- ✅ Responsive layouts; reduced-motion support

## Milestone 4: 3D experience ✅
- ✅ Procedural city model from graph data (instanced roads and buildings)
- ✅ Route tube with progressive draw; vehicle synchronised with playback
- ✅ Hero scene; 3D petals; bloom and vignette; adaptive quality; WebGL fallback

## Milestone 5: Backend and persistence ✅ / ⚠️
- ✅ Hono API with a consistent response envelope; node:sqlite
- ✅ scrypt passwords; hashed sessions; CSRF; rate limits; CSP and security headers
- ✅ Scenarios (CRUD and duplicate), stored runs, run history, exports (JSON and CSV)
- ✅ GeoJSON import (client and API)
- ⚠️ Password reset is not available (no email service)
- ✅ Live OpenStreetMap acquisition (see Milestone 8)

## Milestone 6: Quality and deployment ✅ / ⚠️
- ✅ Playwright end-to-end tests, including axe in both themes and mobile; all pass (37 after Milestone 9)
- ✅ Bugs found by end-to-end tests fixed (overlay click-through, stale account draft, list semantics)
- ✅ Performance measurements (TEST_PLAN.md §5)
- ✅ Static serverless build verified
- ✅ Dockerfile, CI workflow, Pages workflow committed
- ✅ Docker verified: image build, non-root user, health check, smoke test, persistence across restart and `compose down`/`up`, test target (see DEPLOYMENT.md)
- ✅ GitHub Actions verified on GitHub: `verify` and `docker` jobs green
- ❌ Public deployment (needs a hosting account owned by the project owner)

## Milestone 7: Directed, mixed and multi-vehicle routing ✅
- ✅ One-way model (`oneway`, `reverseWeight`), validation policy (`reject` / `ignore` / `directed`), and provenance and routing settings stored with the graph
- ✅ Directed postman by minimum-cost flow, with an LP certificate, flow decomposition and a directed Hierholzer circuit, in a separate module
- ✅ Mixed (`either`) postman solved exactly by orientation enumeration (≤ 12 two-way required streets); larger instances are refused
- ✅ Feasibility diagnosis (no-return / unreachable streets) with a one-click fix
- ✅ Independent state-space cross-check (in-engine) and a Python oracle (networkx min-cost flow + state search, 1,401 graphs)
- ✅ Fleet planning: min–max route splitting (FHK and exact split DP), lower bound, honest guarantee (2 − 1/k undirected; exact for total distance; heuristic for directed), route-length limits, per-vehicle verification
- ✅ `POST /api/route`, stored runs with settings, fleet CSV and JSON v2 exports

## Milestone 8: Real map data ✅ / ⚠️
- ✅ OSM conversion (`osm.ts`): intersection detection, one-way semantics, duplicates, largest component, provenance and attribution
- ✅ Live acquisition: Overpass providers in order with classified errors, a 7-day cache, bbox and response caps, concurrency limits; Nominatim search throttled to 1 request/s
- ✅ Real bundled sample: Zurich Altstadt (ODbL), retrieved from `overpass.osm.ch`, unedited (provenance in `examples/data/README.md`)
- ✅ GeoJSON import keeps one-way properties
- ⚠️ Live acquisition depends on outbound access to a public Overpass instance; the tests mock providers by design

## Milestone 9: Workspace experience overhaul ✅
- ✅ Long-form workspace with surfaces A–I (command header, 3D simulation, projection, mathematics, laboratory, editor, verification, history, export)
- ✅ 3D district from the network: streets, junctions, one-way arrows, building archetypes aligned to streets, trees; camera reset, top-down, frame route, focus node and follow
- ✅ Spectral route shader driven by true route distance (moving band, leading highlight, halo, trail, bloom); repeated passes and directions on separate lanes; reduced-motion and WebGL fallbacks
- ✅ Mathematical investigation generated from the actual record and highlighted in the city and the projection
- ✅ Laboratory: exact vs baselines, required vs total, directed vs relaxation, fleet sweep
- ✅ Local experiment history, "Clear local data" with confirmation, GeoJSON and fleet exports
- ✅ Blossom field with per-zone intensity (reduced over the editor, silent while dragging)

## Future ideas (not started)
- Exact Rural Postman Problem for small instances (branch and bound)
- Exact min–max fleet routing for small instances; capacitated arc routing
- Turn penalties; time windows
- Building footprints from OSM for the 3D city
