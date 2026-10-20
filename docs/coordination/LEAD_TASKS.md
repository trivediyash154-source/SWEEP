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

## Change of plan (owner's decision, 2026-10-20)

The owner does **not** want a real-world map service. They want **our own city map to be much larger**: tens of km² instead of the 4 × 4 km Pune extract. SWEEP's algorithms must visibly solve routing and sweeping on it, for a demonstration.

* The lead is generating a **synthetic demo city** of about 10 × 10 km (100 km²): arterial grid, ring road, radial avenues, a river with bridges, dense centre streets with one-way pairs, and generated buildings. It is a normal city bundle: `apps/web/public/cities/demo-metro.json`, with an entry in `cities/index.json`, id `demo-metro`.
* It is marked synthetic in the data: `provenance.source === 'synthetic'`. Real cities keep `'OpenStreetMap'`. The lead adds this to the `CityProvenance` type in the engine.
* The Directions and Sweep-planner pages are parked on branch `claude/real-map-pages`. Do not link to `/directions` or `/sweep`.

## Tasks (in order)

- [ ] **T1. City picker and honest labels in `/workspace`.**
  * List the cities from `cities/index.json` in a picker in the workspace header.
  * Default to `demo-metro` when it exists in the index, otherwise `pune-bibwewadi`.
  * Support `?city=<id>` in the URL and remember the last choice in localStorage. Reset the route, coverage and scenario state when the city changes.
  * When `city.provenance.source === 'synthetic'`:
    * the header chip must read "Synthetic demo city: generated, not a real place", never "Real OpenStreetMap data";
    * the provenance dialog, both reports, GPX/CSV exports and page titles must say the data is generated;
    * no "OpenStreetMap" attribution, and no "Pune" or "VIT" wording, for that city.
  * Real cities keep their current labels.
  * e2e: the picker switches cities, the URL parameter works, and the synthetic labels appear and the OSM ones do not.
- [ ] **T2. Performance on the big city.** Expect about 10–20 k intersections, 20–30 k segments and 20–40 k buildings.
  * Measure: load and decode time, mesh build, first frame, and routing-worker startup (CH preprocessing grows with the graph).
  * Fix what is slow, for example: a progress message during routing preprocessing, building level of detail or culling, and fewer draw calls.
  * Coverage zones on the big city should stay responsive. If a zone is too large for interactive planning, say so before planning rather than freezing.
  * Report the before/after numbers in your status file.
- [ ] **T3. Fix the intermittent page freeze in headless Chromium** (unchanged from your first prompt). Reproduce it, find the root cause, fix it, and report the numbers. Never weaken a test.
- [ ] **T4. Make the workspace understandable** (unchanged): a first-visit guide, plain-language labels and tooltips, and empty states that say what to click next. A clear top-down view matters more than 3D effects. It must be usable on a phone.
- [ ] **T5. Landing page.**
  * Present the product clearly, with calls to action to `/workspace` (the big demo city and Pune) and `/lab`.
  * Say honestly what is real data and what is generated.
  * Keep the 3D hero light, with a static fallback on software rendering.

## Rules (the owner's)

* Never fabricate data, timings or guarantees. Never call a heuristic optimal. No sign-in gate.
* Never label the synthetic city as real, and never label real data as synthetic.
* Never weaken, skip or delete tests. No model names in commits or PR text. No secrets.
* Before every push: `pnpm typecheck && pnpm lint && pnpm test` and the e2e specs you own. Run the full `pnpm verify` before your final push.

## Lead's log

* 2026-10-20 00:40 UTC: plan changed to the synthetic big city. The demo-city bundle lands on `claude/peaceful-cray-qmjciz` within the next hours; merge it when it appears (see protocol, step 2). Until then, build the picker against `pune-bibwewadi` alone, and test the synthetic labels with a small fixture bundle written by your test.
