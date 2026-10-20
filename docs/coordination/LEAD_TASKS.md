# Coordination: tasks for the city-UX session

Two Claude sessions build SWEEP at the same time:

* **Lead session**: works on branch `claude/peaceful-cray-qmjciz` and writes ONLY this file.
* **City-UX session**: works on branch `claude/city-ux` and writes ONLY `docs/coordination/CITY_UX_STATUS.md`.

No file is ever written by both sessions, so nothing is overwritten. The lead merges `claude/city-ux` at the end and deploys.

## Protocol for the city-UX session

1. At the start, and after finishing each task, read the latest version of this file:
   `git fetch origin claude/peaceful-cray-qmjciz && git show origin/claude/peaceful-cray-qmjciz:docs/coordination/LEAD_TASKS.md`
2. Bring the lead's work into your branch with a merge, never a rebase: `git merge origin/claude/peaceful-cray-qmjciz`. The files are disjoint, so this merges cleanly. If it ever conflicts, keep the lead's version of lead-owned files.
3. After each task:
   * update `docs/coordination/CITY_UX_STATUS.md`: what is done, test results, open questions, requests for the lead;
   * commit and push to `claude/city-ux`.
4. Work the tasks in the order below. When all are done, check this file again for new tasks. If there are none, write "idle, waiting for tasks" in your status file.
5. Never push to `claude/peaceful-cray-qmjciz`, `claude/laughing-ramanujan-wg70al` or `main`, never merge pull requests, and never deploy.

## File ownership

| City-UX session (you) | Lead session (do not edit) |
|---|---|
| `apps/web/src/city/**` | `packages/engine/**` |
| `apps/web/src/three/**` | `scripts/city/**` (data pipeline, demo-city generator) |
| `apps/web/src/landing/**` | `apps/web/public/cities/**` (city bundles and index) |
| `apps/web/src/lib/webgl.ts`, `apps/web/src/components/WebGLBoundary.tsx` | `data/**` |
| `apps/web/src/styles/city.css`, `apps/web/src/styles/landing.css` | `apps/web/src/App.tsx`, `apps/web/src/components/SiteNav.tsx` |
| `e2e/city.spec.ts`, `e2e/landing.spec.ts`, `e2e/a11y.spec.ts`, `e2e/responsive.spec.ts`, `playwright.config.ts` | `apps/web/package.json`, `pnpm-lock.yaml` (add no dependencies) |
| `scripts/city-screenshots.mjs`, `docs/screenshots/city-*.png` | `README.md`, `HANDOFF.md`, `IMPLEMENTATION_STATUS.md`, `TEST_PLAN.md`, `DEPLOYMENT.md`, `MATHEMATICAL_SPEC.md`, `docs/FINAL_REPORT.md`, `.github/**` |
| `docs/coordination/CITY_UX_STATUS.md` | `docs/coordination/LEAD_TASKS.md` (this file) |

Anything not listed belongs to the lead. If you need a change in a lead-owned file, write it under "Requests for the lead" in your status file.

## Plan (owner's decision, 2026-10-20, final: REAL data only)

* **No synthetic city.** Ignore any earlier mention of a generated "demo-metro" city: it will not be built. Every map shows real OpenStreetMap data.
* The Pune workspace (`/workspace`) keeps the real Pune extract (59 of 85 tiles, about 4 × 4 km around VIT Bibwewadi).
* The lead is finishing two real-map pages:
  * `/directions`: search any real place and get A→B routes anywhere, on a full map;
  * `/sweep`: draw a zone over any real streets; they are downloaded live from OpenStreetMap and planned with SWEEP's exact coverage engine.

  These pages give the "big map". Link to them from the landing page; with react-router, `<Link to="/directions">` works in both builds.

## Tasks (in order)

- [ ] **T1. Fix the intermittent page freeze in headless Chromium.**
  * Reproduce: load `/workspace` repeatedly in fresh browser contexts, wait for `networkidle`, then check the city name. About 5–15 % of loads stall while the 3D scene starts: the main thread is blocked outside JavaScript, and the scene chunks get no response.
  * Find the root cause and fix it. Report before/after numbers. Never weaken a test.
- [ ] **T2. Make the Pune workspace understandable.**
  * Add a first-visit guide (dismissible, remembered) for Route lab, Coverage & fleet and Scenarios.
  * Use plain-language labels and tooltips that explain lower bound, gap, deadhead and makespan.
  * Make empty states say what to click next.
  * Make a clear top-down view the default; it matters more than 3D effects.
  * It must be usable on a phone.
- [ ] **T3. Accept `?from=<lat>,<lng>&to=<lat>,<lng>` (and an optional `&profile=`) in `/workspace`.** The Route lab then opens with the nearest intersections as origin and destination and runs the comparison. The Directions page will link there when both points are inside the Pune extract. Add an e2e test.
- [ ] **T4. Landing page.**
  * Present the product clearly, with calls to action to Directions (`/directions`), Sweep planner (`/sweep`), the Pune algorithm lab (`/workspace`) and the network lab (`/lab`).
  * Say honestly what each does, for example: "Directions are computed by the public OSRM service; SWEEP's own exact algorithms run in the Pune lab and the Sweep planner".
  * Keep the 3D hero light, with a static fallback on software rendering.

## Rules (the owner's)

* Never fabricate data, timings or guarantees. Never call a heuristic optimal. No sign-in gate.
* Never label the synthetic city as real, and never label real data as synthetic.
* Never weaken, skip or delete tests. No model names in commits or PR text. No secrets.
* Before every push: `pnpm typecheck && pnpm lint && pnpm test` and the e2e specs you own. Run the full `pnpm verify` before your final push.

## Lead's log

* 2026-10-20 00:40 UTC: the plan briefly changed to a synthetic big city.
* 2026-10-20 00:55 UTC: **reverted by the owner: real data only, no synthetic city.** The tasks above are current. The lead restores `/directions` and `/sweep` on `claude/peaceful-cray-qmjciz`. Merge that branch into yours when you see the new commits.
