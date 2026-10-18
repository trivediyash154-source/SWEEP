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
- ⚠️ Live OpenStreetMap retrieval is not implemented (Overpass blocked here); use GeoJSON import

## Milestone 6: Quality and deployment ✅ / ⚠️
- ✅ Playwright end-to-end tests (32), including axe in both themes and mobile; all pass
- ✅ Bugs found by end-to-end tests fixed (overlay click-through, stale account draft, list semantics)
- ✅ Performance measurements (TEST_PLAN.md §5)
- ✅ Static serverless build verified
- ✅ Dockerfile, CI workflow, Pages workflow committed
- ⚠️ Docker build not run (no daemon in the environment); GitHub Actions have not run yet
- ❌ Public deployment (needs a hosting account owned by the project owner)

## Future ideas (not started)
- Directed and mixed postman problems (minimum-cost flow / ILP)
- Multi-vehicle k-postman and capacitated arc routing (heuristics, clearly labelled)
- Exact Rural Postman Problem for small instances (branch and bound)
- Turn penalties; time windows
- OSM import via a cached, policy-compliant fetcher where network access allows
