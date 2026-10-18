# SWEEP: Deployment

## What has actually been verified

| Mode | Status |
|---|---|
| Production server (`pnpm build && pnpm start`) serving the API and the built web app on one origin | **Verified** in the development container: health check, all API flows, and the full Playwright suite against this server |
| Static serverless build (`pnpm build:static`) served by a plain static file server | **Verified**: optimisation runs in the browser worker (for example Crescent Quay gives 360 m) |
| Docker image | Dockerfile provided, **not built here** (no Docker daemon in the container) |
| GitHub Actions CI and Pages workflows | Committed, **not yet run** |
| Public hosting | **Not deployed.** This needs an account on a hosting provider, which this environment does not have. |

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

No secrets, API keys or third-party services are required.

## Docker

```bash
docker build -t sweep .
docker run -p 8787:8787 -v sweep-data:/data sweep
```

The image runs one Node process, keeps the SQLite file at `/data/sweep.db`, and has a `HEALTHCHECK` on `/api/health`. Put it behind HTTPS (Secure cookies are on in production).

## Static demo on GitHub Pages

`.github/workflows/pages.yml` builds `apps/web/dist-static` (HashRouter, relative asset paths, in-browser engine, local saving, no accounts) and deploys it to Pages.

**One manual step:** in the repository settings, open *Pages* and set *Source* to **GitHub Actions**. Then run the workflow, or push to `main`.

## Hosting the full app (server + accounts)

Any host that runs a Docker image or a Node 22 process with a persistent disk works, for example Render, Fly.io, Railway or a VM. Each needs **an account created by the owner** and a persistent volume for `/data`. These steps cannot be performed from this environment.

## Health and operations

* `GET /api/health` returns `{ status, engine, database, time }`.
* Logs are JSON lines on stdout (`sweep_server_listening`, `user_registered`, `unhandled_error` with a request id).
* Back up the SQLite file (and its `-wal` file) while the server is stopped, or use `sqlite3 .backup`.
* Single instance only: rate limits are in memory and SQLite is single-writer.
