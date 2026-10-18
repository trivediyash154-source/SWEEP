# SWEEP: Test Plan and Results

> A beautiful frontend with incorrect mathematics is a failed project.

**One command runs everything:** `pnpm verify`. It runs the typecheck, unit, property and integration tests, the Python oracle, the production build, and the Playwright end-to-end and accessibility suite.

## Latest recorded run (2026-10-18)

The run used Linux 6.18, a 4-core Intel Xeon at 2.10 GHz, Node 22.22.0, Python 3.13 with networkx 3.5, and Chromium 141 headless (Playwright 1.56.1, software WebGL via SwiftShader). `pnpm verify` **exited with status 0**.

| Suite | Command | Result |
|---|---|---|
| Typecheck (engine, server, web) | `pnpm typecheck` | passed |
| Engine unit + property tests | `pnpm --filter @sweep/engine test` | **36 / 36 passed** |
| Server integration tests | `pnpm --filter @sweep/server test` | **16 / 16 passed** |
| Web unit tests | `pnpm --filter @sweep/web test` | **5 / 5 passed** |
| Python oracle | `pnpm test:oracle` | **660 graphs; 536 compared with networkx, 439 with brute force; all agree**. The other 124 were rejected by SWEEP, and the oracle confirmed each of those graphs genuinely has disconnected required streets. |
| Production build | `pnpm build` | passed |
| End-to-end + accessibility | `pnpm test:e2e` | **32 / 32 passed** (desktop 1440×900 and mobile 390×844) |

Bugs that the end-to-end suite found and that were then fixed: overlay strokes intercepted clicks on streets while connecting; account scenarios could persist in the local draft after sign-out; a list in the library lacked list semantics for screen readers.

## 1. Mathematical tests (`packages/engine/test`)

| Test | What it proves |
|---|---|
| `solver.property.test.ts`: vs exhaustive | For **1,200 random multigraphs** (≤ 7 vertices, ≤ 11 edges, with loops, parallel edges, zero and fractional weights, optional edges), whenever SWEEP solves a graph its total equals the **exhaustive optimum** over all edge-duplication sets. Every check passes; the independent verifier passes; the greedy baseline is never better; the total is never below the lower bound. Every rejection is a genuine disconnection. |
| `solver.property.test.ts`: multiplicity | For 250 graphs, exhaustive search allowing 0, 1 or 2 extra copies gives the same optimum as 0 or 1 copies, which justifies the search space |
| `solver.property.test.ts`: determinism | The same input gives an identical route and hash |
| `matching.test.ts` | Blossom matching equals brute force on 1,500 random sparse graphs, with and without max cardinality, and its certificate always verifies. On 800 random complete metrics (k ≤ 14), blossom equals the subset DP. Optimal ties are counted exactly. A k = 120 instance carries a verified certificate. |
| `examples.test.ts` | Every bundled example: all checks pass and the result is certified optimal; small examples equal the exhaustive optimum. Specific facts: Königsberg has 4 odd landmasses and 9 steps; Heritage Loop is Eulerian with zero repeats; Riverside duplicates the middle rung; Old Town has 8 odd vertices with the DP agreeing; **Crescent Quay: optimal adds 80 m, greedy adds 140 m**; Four Corners has 2 optimal pairings; Twin Districts is rejected and the suggested connectors fix it; Plaza uses a zero-weight link; Market Avenues deadheads 420 m on 3 optional streets; Meridian has more than 50 odd vertices and is certified. |
| `validation.test.ts` | Empty graphs, no required streets, duplicate or invalid ids, missing endpoints, invalid weights and coordinates, directed edges, loops, parallel and zero-weight edges, isolated vertices, unreachable versus disconnected required streets, depot rules, limits |
| `geojson_io.test.ts` | Splitting at shared points, geodesic length (0.001° of longitude at 18.52°N ≈ 105.5 m), skipped geometries, invalid input, one-way warnings, JSON parsing that drops unknown fields, CSV formula-injection neutralisation, Euler circuit on multigraphs with loops |
| `sha256.test.ts` | FIPS 180-4 test vectors; canonical JSON |

**Independent oracle** (`oracle/run_oracle.py`). Python generates 650 random graphs (500 small, 150 with up to 40 vertices and 90 edges), plus the bundled examples. It solves them by:

* networkx `min_weight_matching` over Dijkstra distances, and
* brute force over duplication sets, for graphs with ≤ 12 edges.

It also re-walks every SWEEP route. The oracle shares no code with the engine.

## 2. Integration tests (`apps/server/test/api.test.ts`)

Health and security headers; examples and optimisation; validation diagnostics; malformed and oversized input; CSRF (missing token, forged token, cross-origin); GeoJSON import; registration, login and logout with hashed storage; cookie flags; generic errors; registration validation; session expiry; password change revoking sessions; rate limiting; the scenario lifecycle (create, rename, duplicate, run, re-run equal to the stored run, fetch run, CSV export whose last cumulative equals the total, JSON export, delete cascading to runs); **ownership enforced on all 8 scenario and run endpoints**; account deletion.

## 3. Browser tests (`e2e/*.spec.ts`, Playwright)

| Spec | Coverage |
|---|---|
| `landing.spec.ts` | The hero and the live instrument; the ledger row equals engine output; WebGL canvas or fallback; the cursor field has `pointer-events: none` and links under it stay clickable; under reduced motion there is no field and the toggle state is right; theme toggle and persistence; mathematics page figures; 404 |
| `workspace.spec.ts` | Example → optimise, where the total equals the engine total and all checks show as passed; Crescent Quay (360 m vs greedy); building a network from scratch (add, connect, edit length, optimise, undo marks the result stale); explain steps driven by the real record; disconnected example → connectors → optimal; playback readout advances and holds on pause; 3D view or fallback; JSON and CSV export equal to the engine; report consistent with the workspace; GeoJSON import; local save and reload; keyboard-editable streets table |
| `auth.spec.ts` | Register; save to account; stored run history; reload; sign out guards the account page; a second user cannot open the first user's scenario; generic sign-in error |
| `responsive.spec.ts` (mobile) | The workspace optimises at 390 px; no horizontal overflow on the landing page or workspace |
| `a11y.spec.ts` | axe-core on `/`, `/workspace`, `/mathematics`, `/signin` and `/register` in **both themes**: no serious or critical violations (canvas elements excluded) |

## 4. Web unit tests (`apps/web/src/**/*.test.ts`)

* **Petal system:** emission is proportional to distance, not to the number of events (3 large moves and 300 small moves both give 30 petals); the pool is bounded; dead particles are recycled; nothing sprays on re-entry; intensity 0 and the bloom limit are respected.
* **Route geometry:** progress maps onto true distance (0 → 0, end → total); distance is monotone; no spatial jumps over 2,000 samples (no teleporting).

## 5. Performance (measured, not targets)

### Engine (`pnpm bench`, Node 22, 4-core Xeon at 2.10 GHz)

| Network | Vertices | Edges | Odd k | Median solve |
|---|---:|---:|---:|---:|
| Königsberg | 4 | 7 | 4 | 0.71 ms |
| Old Town Grid | 16 | 24 | 8 | 1.82 ms |
| Market Avenues | 20 | 31 | 2 | 0.39 ms |
| Meridian District | 351 | 595 | 148 | 43 ms |
| synthetic 30×22 | 660 | 1,121 | 284 | 188 ms |
| synthetic 40×30 | 1,199 | 2,052 | 458 | 709 ms |
| synthetic 50×36 | 1,800 | 3,110 | 696 | 2,305 ms |
| synthetic 60×44 | 2,640 | 4,574 | 958 | 5,899 ms |

Matching dominates, as expected for O(k³). The default interactive limit is therefore **600 odd vertices** (about 1.5 s by interpolation). Raw results are in `packages/engine/bench/results.json`.

### Frontend (headless Chromium, software WebGL)

| Measurement | Result |
|---|---|
| First contentful paint `/` (local server) | 100 ms |
| First contentful paint `/workspace` (Meridian) | 100 ms |
| rAF frame interval, landing with hero off-screen and **petal field active** while the pointer moves | median 16.7 ms, p95 16.8 ms (180 frames / 3 s) |
| Same, with the petal field **disabled** | median 16.7 ms, p95 16.8 ms (181 frames / 3 s) |
| JS heap before and after 6 play/pause/restart cycles (Meridian) | 9.2 MB → 10.5 MB |
| UI re-optimise round trip, Meridian (worker-thread solve on the server) | 321 ms |
| Initial JS (gzip) | 87 KB app shell + 52 KB landing; 3D chunk (264 KB) is lazy |

**Caveats.** Hero 3D frame rates are not reported. They are dominated by SwiftShader software rendering in this container and do not represent GPU hardware. The scene lowers its resolution and disables post-processing automatically when the frame rate declines. Load times were measured on localhost without network latency.

## 6. Manual visual review

Playwright screenshots were reviewed for every main screen in both themes and at phone width. A selection is in `docs/screenshots/`.

## 7. Not verified

* The Docker image build: the container has the Docker CLI but no daemon.
* GitHub Actions runs: the workflows are committed but have not run yet.
* Real-GPU frame rates.
* Deployment to a public host.
