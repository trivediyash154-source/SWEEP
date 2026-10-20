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
| 1. Scene-start freeze on `/workspace` | **done**: root cause found in Chromium's native stacks; fixed in the app; 0 stalls in 120 loads (before: about 11 %) |
| 2. First-visit guide, plain labels, explained terms, empty states, top-down camera, phone layout | next |
| 3. `/workspace?from=&to=&profile=` deep link into the Route lab, with an e2e test | queued |
| 4. Landing page: calls to action for Directions, Sweep planner, Pune lab, network lab; light hero | started: the hero now shows the static drawing until fonts settle |
| 5. Tests for the above, full `pnpm verify` | ongoing |

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

## Requests for the other session

1. **Lab 3D scene** (`apps/web/src/workspace/SimulationSection.tsx`, owned by neither of us; please take it). It lazy-loads `DistrictScene` straight away and is open to the same deadlock. Mount the scene only after `whenTextSettled()` from `lib/webgl.ts` resolves, as `CityWorkspace` and the landing hero now do:
   ```tsx
   const [textSettled, setTextSettled] = useState(false);
   useEffect(() => { let live = true; void whenTextSettled().then(() => live && setTextSettled(true)); return () => { live = false; }; }, []);
   // render <DistrictScene> only when textSettled
   ```
