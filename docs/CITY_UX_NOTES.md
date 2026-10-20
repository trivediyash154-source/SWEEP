# City UX workstream: notes and status

Owner of this file: the **city-UX session**. Branch `claude/city-ux`; one draft PR into `claude/peaceful-cray-qmjciz`. The **main session** owns that branch, merges this PR at the end and deploys.

## How the two sessions coordinate

* **Status (this file).** The city-UX session keeps the status below current and pushes it with its work. The main session reads it here or in the PR.
* **Instructions to the city-UX session.** Post them as a comment on this branch's PR starting with `[main]`, for example `[main] Next: ...`. Both sessions post from the same GitHub account, so these comments do not arrive as events; the city-UX session reads the PR's comments at every step and on a schedule. It replies on the PR starting with `[city-ux]` and updates this file.
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
| 1. Scene-start freeze on `/workspace` | **done**: root cause found in Chromium's native stacks; fixed in the app; 0 stalls in 120 loads (before: about 11 %) |
| 2. First-visit guide, plain labels, explained terms, empty states, top-down camera, phone layout | **done** (see below); 3 new e2e tests |
| 3. `/workspace?from=&to=&profile=` deep link into the Route lab, with an e2e test | **done** (see below); 4 unit tests, 2 e2e tests |
| 4. Landing page: calls to action for Directions, Sweep planner, Pune lab, network lab; light hero | **done** (see below); 3 new e2e tests |
| 5. Tests for the above, full `pnpm verify` | see "Final checks" below |

## 1. The `/workspace` freeze: root cause and fix

**Harness.** Load `/workspace` in a fresh browser context each time, with the e2e suite's Chromium flags (SwiftShader). Wait for `networkidle`, then for the city name and the built meshes. A load counts as a stall when the page no longer answers `page.evaluate`.

| Run (40–120 loads each) | Stalls |
|---|---|
| baseline at `7e4e619` | 4 of 40; 5 of 40 with page instrumentation |
| `--disable-webgl --disable-3d-apis` | 3 of 40 |
| every worker started 3 s late (wrapper injected into the page) | 12 of 40 |
| web fonts blocked (all `.woff2` requests aborted) | 5 of 60 |
| **after the fix** | **0 of 120** |

**Where it stops.** Page instrumentation showed the city JSON arriving (about 0.45 s), the scene chunks being requested (about 0.53 s), then nothing:
* no `<canvas>` was inserted;
* `getContext` was never called;
* a 250 ms timer never fired again.

WebGL is not involved.

**Root cause.** `gdb` native stacks of the frozen renderer show a thread-pool starvation deadlock inside Chromium.

* **Main thread:**
  ```
  font_service::internal::FontServiceThread::FontRenderStyleForStrike   (WaitableEvent::Wait)
  content::WebSandboxSupportLinux::GetWebFontRenderStyleForStrike
  blink::FontCache::GetLastResortFallbackFont
  blink::RemoteFontFaceSource::CreateFontData      (a web font still loading, font-display: swap)
  blink::InlineNode::PrepareLayout                 (laying out the panels' text)
  ```
  It is waiting for a synchronous font-service call, which runs as a task on the renderer's thread pool.
* **Every thread-pool worker:**
  ```
  v8::internal::CollectionBarrier::AwaitCollectionBackground
  ... v8::internal::BackgroundCompileTask::Run
  blink::BackgroundResourceScriptStreamer::...::RunScriptStreamingTask   (the 3D scene chunks)
  ```
  One worker is in the baseline compiler instead. All are waiting for the main thread to collect garbage.
* **The cycle:** the font task never gets a worker, and the main thread never collects. The browser process was idle; no thread was in fontconfig.
* **What triggers it:** heavy background script compilation (the 3D scene chunks) at the same moment as the main thread's first fallback-font lookups (the panels first laid out while web fonts load). This explains why disabling WebGL or blocking web fonts did not help, why delaying workers made it worse (probably because more compilation then overlapped the first layout), and why a pause between loads helped.

**Fix (app code; no Chromium flag, no test changed).**
* `lib/webgl.ts` gains `whenTextSettled()`. It loads every Latin web-font face the app declares, waits for `document.fonts.ready` and two laid-out frames, and gives up after 4 s.
* `CityWorkspace` fetches and compiles the 3D scene only after that, so no first-time font lookup coincides with the compile.
* The landing hero shows its static network drawing until then, and then loads the 3D hero.

**Checks after the fix:**
* stress harness: 0 stalls in 120 loads;
* `e2e/city`, `landing`, `a11y` and `responsive` specs: 36 of 36;
* typecheck and lint clean; unit tests: engine 178, server 38, web 29.

## 2. Making `/workspace` understandable

* **Getting-started guide** (`panels/CityGuide.tsx`), at the top of the side panel on the first visit. It is not a modal, so nothing on the map is blocked.
  * One plain sentence for each tool: Route lab, Coverage & fleet, Scenarios.
  * "Try this" steps for the selected tool, using the panel's own button names.
  * "Hide guide" is remembered in localStorage (`sweep.cityGuide`); "How does this work?" brings it back.
* **Terms explained where they appear** (`glossary.ts`, `panels/Term.tsx`). A small "?" button with `aria-expanded` reveals a plain definition:
  * lower bound, gap, transit (deadhead) and last vehicle back (makespan);
  * turn penalties and connectors;
  * exact versus heuristic methods;
  * arcs settled in the Route lab.
* **Plain labels:** "Finish (makespan)" became "Last vehicle back"; "Deadhead" became "Transit"; "Gap to bound" became "Gap to the bound".
* **Empty states say what to click next:** `route-next` (choose a start, then a destination), `cov-next` (draw the zone, then pick the depot) and `scenario-next` (close a road or change a direction).
* **Top-down by default.** The workspace opens on the `top` view of the whole area, readable like a map. The 3D views stay one click away.
* **Phone (≤ 760 px):**
  * the header is two compact rows: name and theme on the first, the three tools on one line below;
  * the camera buttons sit above the bottom sheet;
  * the view is shifted up into the visible band between the header and the sheet;
  * the default top-down view frames about 1.4 km around VIT.
* **Accessibility:** axe found no serious or critical violations on `/workspace` in either theme. The guide's small label uses the muted text colour, because the faint eyebrow grey reached only 3.75:1 on the guide card in Porcelain.
* **Tests:** the city spec gains "first visit: a guide …" and "empty panels say what to click next …"; the responsive spec gains "city workspace on a phone …". City, landing, a11y and responsive specs: 39 of 39.

## 3. Route-lab links

`/workspace?from=<lat>,<lng>&to=<lat>,<lng>[&profile=car|truck|bicycle|foot]` (`city/deepLink.ts`, wired in `CityWorkspace.tsx`).

* **What it does:** opens the Route lab, snaps each point to the nearest intersection of the bundled extract, sets the profile (car when none is given) and runs the five-algorithm comparison.
* **What it refuses,** with a plain notice (`route-link-error`) instead of a misleading snap:
  * a point outside the extract's bounds, or more than 250 m from any intersection; the notice points to the Directions page;
  * a point that is not `lat,lng`;
  * a link with only one of `from` / `to`;
  * an unknown profile.
* **When it applies:** once per link. A different link followed while the page is open applies too.
* **Linking from Directions:** use `<Link to={`/workspace?from=${lat},${lng}&to=${lat},${lng}&profile=car`}>`; the query sits inside the hash in the static build, and `useSearchParams` reads it there. A point inside the extract's rectangle but more than 250 m from a street is refused, so the page can safely offer the link whenever both points are inside the Pune bounds.
* **Tests:**
  * `deepLink.test.ts`, 4 tests on the real bundle: absent link, exact snap with a profile, a point 20 m off, refusals.
  * `e2e/city.spec.ts`, 2 tests:
    * a truck link opens the Route lab; the origin is the nearest intersection, checked by great-circle distance over all nodes; all five algorithms return the engine optimum;
    * a Mumbai point is refused and the panel still says what to do next.
* **Checks after merging `c9af0f8`:** typecheck and lint clean; unit tests engine 178, web 50, server 38; city, landing, a11y and responsive specs 41 of 41.

## 4. Landing page

* **"Start here": four tools,** in the site navigation's order. Each card is one link (the whole card is clickable; the link's name is the tool's name). Each says what the tool does and who computes the answer:
  * **Directions:** anywhere; computed by the public OSRM service on OpenStreetMap data, not by SWEEP; free-flow times, no live traffic.
  * **Sweep planner:**
    * any real zone up to 25 km², downloaded live from OpenStreetMap in polite tiles;
    * the four one-click Pune example zones: around VIT (1 km²), Kothrud (4 km²), the old city (9 km²) and the centre (about 20 km²);
    * "Play the shift";
    * SWEEP's own coverage engine, with the proven lower bound and gap on every plan.
  * **Pune algorithm lab:** the bundled Bibwewadi and VIT extract in 3D: five shortest-path algorithms, fleet coverage, road closures.
  * **Network lab:** the exact Chinese Postman method step by step, on sample networks or the reader's own.

  Above the cards: "Directions are computed by the public OSRM service. SWEEP's own algorithms run in the Sweep planner, the Pune lab and the Network lab, and each result there is either proven optimal or shown with a proven bound."
* **Hero:**
  * "Plan a sweep" (`/sweep`) and "Open the Pune lab" (`/workspace`), plus "Explore the mathematics";
  * a lede about what SWEEP does now;
  * a note that the district drawn behind the title is a synthetic illustration, while the planner and the Pune lab use real streets.
* **Light hero.** The static drawing is the hero. The 3D scene is added only when all of these hold:
  * a wide screen (at least 900 px) with a fine pointer;
  * no data saving and no reduced motion;
  * the fonts have settled and the browser is idle.

  Once loaded, it stays, and "Pause motion" only pauses it. On a phone the drawing sits faintly behind the title, clear of the buttons.

  | JavaScript fetched by `/` within 8 s (uncompressed, 3 loads each) | Before | After |
  |---|---|---|
  | desktop 1440 × 900 | 1,492 KB, 3D hero | 1,497 KB, 3D hero (loaded when idle) |
  | phone 390 × 844 | 1,492 KB, 3D hero | **550 KB**, static, no WebGL context |
  | desktop, reduced motion | 1,492 KB, 3D hero (still) | **550 KB**, static, no WebGL context |
* **Stale copy corrected:**
  * the "workspace" section described the network lab but linked to `/workspace`; it now says "The network lab" and links to `/lab`;
  * the method list now covers one-way streets (min-cost flow), the bounded heuristic for large zones, fleets and the five shortest-path algorithms;
  * the limitations list no longer claims "no one-way streets, fleets or turn penalties". It now states the real limits: OSRM for Directions, live downloads up to 25 km², the partial Pune extract and estimated heights, and the network lab's connectivity and 600-odd-intersection limits;
  * the footer links all four tools.
* **Tests:** `landing.spec.ts` gains "four tools, each card a link, saying who computes the result" and "a light hero …"; `responsive.spec.ts` gains "landing on a phone: a static hero without the 3D code …". Axe is clean on `/` in both themes.

## Final checks

* **Full `pnpm verify`** on the merged head `84624b0` (with the main session's `9ddebb9`), 02:02–02:15 UTC: exit 0.
  * typecheck and lint clean;
  * unit tests: engine 178, server 38, web 50;
  * the Python oracle: all comparisons agree (661 undirected and 1,401 directed or mixed graphs);
  * build;
  * browser tests 73 of 73.
* **After that run,** two changes followed:
  * `.ledger .good` and `.plate__figure--good` (route-coloured text) now use the main session's `--route-ink` token;
  * `docs/screenshots/city-*.png` were recaptured. The theme pair shows the first-visit guide; the route and coverage shots hide it.

  Checked again: typecheck and lint clean, unit tests 178 / 38 / 50, city / landing / a11y / responsive specs 44 of 44.
* **New tests from this workstream:** 8 e2e tests (city 4, landing 2, responsive 2) and 4 unit tests (`deepLink.test.ts`). No test was weakened, skipped or removed, and no timeout was raised.

## Requests for the other session

1. **Closed:** done by the main session in `e2c5fec`. **Lab 3D scene** (`apps/web/src/workspace/SimulationSection.tsx`, owned by neither of us). It lazy-loads `DistrictScene` straight away and is open to the same deadlock. Mount the scene only after `whenTextSettled()` from `lib/webgl.ts` resolves, as `CityWorkspace` and the landing hero now do:
   ```tsx
   const [textSettled, setTextSettled] = useState(false);
   useEffect(() => { let live = true; void whenTextSettled().then(() => live && setTextSettled(true)); return () => { live = false; }; }, []);
   // render <DistrictScene> only when textSettled
   ```
