# City UX workstream: notes and status

Owner of this file: the **city-UX session**. Branch `claude/city-ux`; one draft PR into `claude/peaceful-cray-qmjciz`. The **main session** owns that branch, merges this PR at the end and deploys.

## How the two sessions coordinate

* **Status (this file).** The city-UX session keeps the status below current and pushes it with its work. The main session reads it here or in the PR.
* **Instructions to the city-UX session.** Post them as a comment on this branch's PR starting with `[main]`, for example `[main] Next: ...`. The city-UX session is subscribed to that PR, so each comment reaches it. It replies on the PR starting with `[city-ux]` and updates this file.
* **Requests from the city-UX session to the main session.** Changes to files the city-UX session does not own are listed under "Requests for the other session" below and mentioned in a `[city-ux]` PR comment.
* **Ownership.** The city-UX session edits only:
  * `apps/web/src/city/**`, `apps/web/src/three/**` and `apps/web/src/landing/**`;
  * `lib/webgl.ts`, `components/WebGLBoundary.tsx`, `styles/city.css` and `styles/landing.css`;
  * the city, landing, a11y and responsive e2e specs, and `playwright.config.ts`;
  * `scripts/city-screenshots.mjs`, `docs/screenshots/city-*.png` and this file.

  It never pushes to `claude/peaceful-cray-qmjciz`, `claude/laughing-ramanujan-wg70al` or `main`, never merges and never deploys.

## Status

| Task | State |
|---|---|
| 1. Scene-start freeze on `/workspace` | in progress: reproduced (see below) |
| 2. First-visit guide, plain labels, explained terms, empty states, top-down camera, phone layout | not started |
| 3. Landing page: calls to action for Directions, Sweep planner, Pune lab, network lab; light hero | not started |
| 4. Tests for the above, full `pnpm verify` | not started |

## 1. Freeze investigation

Reproducer: load `/workspace` in a fresh browser context each time (same Chromium flags as the e2e suite, SwiftShader), wait for `networkidle`, then for the city name and the built meshes. A load counts as a stall when the page no longer answers `page.evaluate`.

* **Baseline at `7e4e619`:** 4 stalls in 40 loads, then 5 in 40 with page-side instrumentation.
* **Where it stops:** in every stall the last events the page logged are, in order:
  * `pune-bibwewadi.json` loaded (about 0.45 s);
  * the geometry worker created (about 0.48 s);
  * the scene chunks requested (about 0.53 s).

  After that, nothing: no `<canvas>` was inserted, `getContext` was never called, and a 250 ms interval timer never fired again. The main thread blocks **before** the WebGL context exists. The scene chunks are compiled while the geometry worker starts.

## Requests for the other session

None yet.
