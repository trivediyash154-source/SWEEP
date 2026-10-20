# SWEEP: Deployment

## What has actually been verified

| Mode | Status |
|---|---|
| Production server (`pnpm build && pnpm start`) serving the API and the built web app on one origin | **Verified** in the development container: health check, all API flows, and the full Playwright suite against this server |
| Static serverless build (`pnpm build:static`) served by a plain static file server | **Verified**: optimisation runs in the browser worker (for example Crescent Quay gives 360 m) |
| Docker image (`docker build`, `docker compose`) | **Verified** in the development container: image built (343 MB, non-root `node` user), container healthy, `/api/health` and `/workspace` answer, optimise/register/scenario/run smoke test passes, data survives `docker restart` and `compose down`/`up`, and the `tests` profile runs the unit and integration suites inside the image |
| GitHub Actions CI | **Verified on GitHub**: the `verify` job (typecheck, lint, unit/integration/property tests, Python oracle, build, Playwright end-to-end and axe in both themes) and the `docker` job (build, health check, smoke test, restart persistence, test target) pass |
| GitHub Pages workflow | Committed; needs Pages enabled once in the repository settings (below) |
| Public hosting | **Verified**: the static build of this version is on Vercel at https://sweep-ashy.vercel.app (project "sweep"), with the city workspace at `/#/workspace`. Deployed on 2026-10-19 (22:56 UTC) from commit `fd4740d` with the Vercel CLI to the existing project "sweep". On the live site, headless Chromium checked the landing page, the lab, the city load, a Route lab comparison (all five algorithms agree) and a coverage plan, with no console errors or failed requests. |
| City workspace in the static build | The city bundle is a static file (`apps/web/public/cities/`), and all city routing and coverage run in browser workers, so `/workspace` needs no server API. Verified with the production server and the e2e suite, and the static build (`pnpm build:static`) was checked in headless Chromium from a plain file server with no API: landing page, lab, city load at `/#/workspace`, the Route lab (all five algorithms agree) and a coverage plan, with no console errors or failed requests. Workers resolve the city URL against the page's base URI (a relative URL inside a worker resolves against `/assets/`). The static build at a sub-path relies on `cityUrl()` honouring `BASE_URL`. |

## Run locally (or on any Node 22 host)

```bash
corepack enable                 # provides pnpm 10
pnpm install
pnpm build                      # engine typecheck, web build, server bundle
pnpm start                      # http://localhost:8787
```

`pnpm start` runs `apps/server/dist/index.js`. When `apps/web/dist` exists (it does after `pnpm build`), the server also serves the web app from the same origin; `SWEEP_STATIC_DIR` overrides that location.

Development, with hot reload for the web app and auto-restart for the API:

```bash
pnpm dev        # web on :5173 (proxying /api to :8787), API on :8787
```

Requirements: Node ≥ 22.5 (for `node:sqlite`) and pnpm 10. Python 3 with networkx is needed only for `pnpm test:oracle`.

## Configuration (environment variables; all optional)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `SWEEP_DB_PATH` | `data/sweep.db` | SQLite file (created automatically) |
| `SWEEP_STATIC_DIR` | `apps/web/dist` if present | Directory of the built web app to serve |
| `NODE_ENV` | unset | `production` enables `Secure` cookies by default |
| `COOKIE_SECURE` | `true` in production | Set `false` **only** for plain-HTTP local testing; with Secure cookies, sign-in needs HTTPS |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` for rate-limit IPs (enable only behind your own proxy) |
| `SWEEP_SOLVER_MODE` | `worker` | `inline` runs the solver on the main thread (tests only) |
| `SWEEP_SOLVER_TIMEOUT_MS` | `20000` | Hard timeout per optimisation |
| `SWEEP_SESSION_TTL_MS` | 7 days | Session lifetime |
| `SWEEP_RATE_LIMIT` | on | `off` disables rate limiting (tests only) |
| `SWEEP_MAP_ACQUISITION` | on | `off` disables live map acquisition (`/api/maps/*` answer 503) |
| `SWEEP_OVERPASS_ENDPOINTS` | see `apps/server/src/config.ts` | Comma-separated Overpass API endpoints, tried in order |
| `SWEEP_NOMINATIM_ENDPOINT` | `https://nominatim.openstreetmap.org/search` | Place search endpoint (throttled to 1 request/s) |
| `SWEEP_MAP_CACHE_DIR` | `data/map-cache` | Acquired datasets are cached here for 7 days |
| `NODE_USE_ENV_PROXY` | unset | Set to `1` behind an HTTP(S) proxy so Node's `fetch` honours `HTTPS_PROXY` |

No secrets, API keys or paid services are required. Live map acquisition uses public OpenStreetMap services under their usage policies (identifying User-Agent, small areas, caching, Nominatim at most 1 request per second); everything else works offline.

## Docker

SWEEP is one Node process (API + built web app) with an embedded SQLite file, so Compose defines exactly one service plus an optional test profile. There is no separate database, cache or worker container.

```bash
cp .env.example .env            # optional; every variable has a default
docker compose up -d --build    # http://localhost:8787 (SWEEP_PORT changes the host port)
docker compose ps               # STATUS shows (healthy) once /api/health answers
docker compose logs -f sweep
docker compose --profile test run --rm tests   # unit and integration suites inside the image
docker compose down             # data stays in the sweep-data volume; add -v to delete it
```

Without Compose:

```bash
docker build -t sweep .
docker run -d -p 8787:8787 -e COOKIE_SECURE=false -v sweep-data:/data sweep
node scripts/docker-smoke.mjs http://127.0.0.1:8787 create .smoke.json   # optimise, account, scenario, run
docker restart <container> && node scripts/docker-smoke.mjs http://127.0.0.1:8787 check .smoke.json
```

The image (multi-stage: cached dependency install, build, slim `node:22-bookworm-slim` runtime) runs as the non-root `node` user, keeps `/data/sweep.db` and `/data/map-cache` on the volume, and has a `HEALTHCHECK` on `/api/health`. Behind a TLS-inspecting proxy, pass its CA as a build secret (`--secret id=ca_bundle,src=ca.pem`); it is used only during `pnpm install` and never stored in the image. Put the container behind HTTPS in production and leave `COOKIE_SECURE` at its default (`true`).

## Static demo on GitHub Pages

`.github/workflows/pages.yml` builds `apps/web/dist-static` (HashRouter, relative asset paths, in-browser engine, local saving, no accounts) and deploys it to Pages.

**One manual step:** in the repository settings, open *Pages* and set *Source* to **GitHub Actions**. Then run the workflow, or push to `main`.

## Static build on Vercel (https://sweep-ashy.vercel.app)

The Vercel project is "sweep". The static build needs no server, no environment variables and no rewrites: it uses hash routes, so the city workspace is at `https://sweep-ashy.vercel.app/#/workspace`. From a machine whose Vercel CLI is logged in to the project's team:

```bash
pnpm install
pnpm build:static                                   # → apps/web/dist-static (checked: city, Route lab and coverage run from a plain file server)
npx vercel deploy apps/web/dist-static --prod       # uploads the built files as they are
```

On the first run the CLI asks which project to use: link it to the existing "sweep" project, not a new one. The build empties `dist-static` each time, which also removes that link, so the question comes back after every build; the answer stays the same.

Then open `/#/workspace`, check that the "Pune · Bibwewadi & VIT" header appears, and run one Route lab comparison. The third session deployed this way on 2026-10-19 from `fd4740d`. It copied `dist-static` into a folder already linked to the project (`.vercel/`) that holds a `vercel.json` with three security headers (`X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`), then ran `vercel deploy --prod --yes`.

## Hosting the full app (server + accounts)

Any host that runs a Docker image or a Node 22 process with a persistent disk works, for example Render, Fly.io, Railway or a VM. Each needs **an account created by the owner** and a persistent volume for `/data`. These steps cannot be performed from this environment.

## Health and operations

* `GET /api/health` returns `{ status, engine, database, time }`.
* Logs are JSON lines on stdout (`sweep_server_listening`, `user_registered`, `unhandled_error` with a request id).
* Back up the SQLite file (and its `-wal` file) while the server is stopped, or use `sqlite3 .backup`.
* Single instance only: rate limits are in memory and SQLite is single-writer.
