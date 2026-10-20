# SWEEP: Security

## Threat model (scope)

SWEEP is a single-instance web application. Each user keeps private scenarios, and anonymous visitors can use the public demo without an account. The assets to protect are user credentials, the privacy and integrity of each user's scenarios and runs, and server availability.

The design defends against:

* Credential theft from a stolen database.
* Session theft and CSRF.
* Account enumeration through error messages.
* Users reading or changing other users' data.
* Malicious uploads (JSON and GeoJSON).
* Oversized requests and unbounded computation.
* XSS, through the CSP and React's escaping.
* Spreadsheet formula injection in CSV exports.
* Abuse of the map-acquisition proxy: using the server against arbitrary hosts (SSRF), injecting into queries, or overloading public OpenStreetMap services.

Out of scope: DDoS beyond the simple per-IP rate limiting, multi-instance deployments (rate limits are held in memory), compromise of the host, and email-based flows (none are implemented).

## Controls (as implemented)

| Area | Control | Where |
|---|---|---|
| Password storage | **scrypt** (N = 2¹⁵, r = 8, p = 1, 64-byte key, 16-byte random salt), stored as `scrypt$N$r$p$salt$hash`; compared with `timingSafeEqual`. Plaintext is never stored or logged. | `apps/server/src/security.ts` |
| Password policy | 10 to 200 characters, plus a small denylist of common passwords | `schemas.ts` |
| Login timing | Unknown emails are verified against a dummy hash, so their response time matches a wrong password | `app.ts` |
| Enumeration | Login always fails with "Email or password is incorrect." Registration with an existing email returns a generic message. | `app.ts` |
| Sessions | 256-bit random token in a `sweep_session` cookie (`HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` in production). The database stores only the token's SHA-256. Sessions expire after 7 days (configurable); expired sessions are deleted when seen. A password change revokes all other sessions. | `app.ts` |
| CSRF | Double-submit token: every POST, PUT, PATCH or DELETE under `/api` needs an `x-csrf-token` header equal to the `sweep_csrf` cookie, compared in constant time. If an `Origin` header is present it must match the `Host`. | `security.ts` |
| Rate limiting | Auth endpoints allow 10 requests/min/IP, optimisation 60/min/IP, and the API overall 600/min/IP (fixed window, in memory). Clients get `429` with `Retry-After`. `X-Forwarded-For` is trusted only when `TRUST_PROXY=true`. | `security.ts`, `app.ts` |
| Authorisation | Every scenario and run query includes `owner_id = ?`. Other users' resources return `404`. Covered by an integration test over every endpoint. | `app.ts`, `test/api.test.ts` |
| Input validation | Zod schemas validate every body: types, lengths, array sizes (≤ 20,000 vertices, ≤ 40,000 edges) and string limits; unknown keys are stripped. The engine then validates semantics. | `schemas.ts`, `engine/validate.ts` |
| Request size | 4 MB body limit, enforced on both the declared and the actual length | `app.ts` |
| Computation limits | At most 600 odd vertices (O(k³) matching). Mixed (`either`) enumeration is limited to 12 two-way required streets (4,096 flows) and fleets to 12 vehicles. Every optimisation runs in a separate `worker_thread`, which is terminated after 20 s and returns `COMPUTATION_TIMEOUT`. | `solver.ts`, `engine/directed.ts`, `engine/fleet.ts` |
| Map acquisition: endpoints | Upstream hosts come **only** from server configuration (`SWEEP_OVERPASS_ENDPOINTS`, `SWEEP_NOMINATIM_ENDPOINT`). The client sends a bounding box and road classes, never a URL, so it cannot point the server at another host. | `server/config.ts`, `server/maps.ts` |
| Map acquisition: queries | The Overpass query is built by the server from a fixed template. Road classes must come from a whitelist, so no client text reaches the query. The bbox must be valid WGS84 and at most 4 km². | `engine/osm.ts` |
| Map acquisition: load | Limits: 6 acquisitions and 30 searches per minute per IP; at most 2 concurrent upstream requests and 8 queued; identical requests are shared; responses are cached for 7 days (searches for 24 h). Nominatim gets at most 1 request/s, with an identifying User-Agent. The regional Swiss instance is used only inside its coverage. | `server/maps.ts` |
| Map acquisition: responses | Timeouts are 45 s per provider. Responses are capped at 25 MB from Overpass and 1 MB from Nominatim, enforced while streaming. Bodies are parsed only with `JSON.parse` and converted with network limits. | `server/maps.ts`, `engine/osm.ts` |
| Map acquisition: errors | Each provider attempt is reported with a classified cause: DNS, TLS, proxy, timeout, rate limit, busy, size or format. Error text is **redacted**: proxy URLs and any `user:password@` credentials are removed, and the text is truncated. Status responses never expose absolute paths. | `server/maps.ts` (`redact`) |
| City data acquisition (offline tool) | `pnpm city:acquire` is a developer command, not a server endpoint. It sends one request at a time, at least 4 s apart, with an identifying User-Agent; it backs off on 429, 5xx and timeouts (6 attempts) and moves to the next configured endpoint only after repeated failures. Responses are cached with a manifest, so reruns download only what is missing. A host refused by a network policy is reported, not retried around. The city workspace itself makes no map requests: it reads the bundled extract. | `scripts/city/acquire.ts`, `data/regions/*.json` |
| City workspace input | Zones, depots, closures and plan overrides are numbers and indexes into the loaded bundle. The coverage worker refuses a depot or disposal site that is not on the zone's network, and the UI refuses zone outlines that cross themselves. Planning runs in Web Workers, so a large plan cannot block the page. Cost assumptions are user inputs used only for arithmetic. | `web/city/zoneShape.ts`, `web/city/*.worker.ts` |
| File parsing | Only `JSON.parse`; never `eval`. GeoJSON has feature, coordinate and range limits. Imports are previewed and validated before loading. | `engine/geojson.ts`, `engine/io.ts` |
| CSV exports | Cells starting with `= + - @ \t \r` are prefixed with `'`, and quoting follows RFC 4180 | `engine/io.ts` |
| Headers | CSP (`default-src 'self'`; no inline scripts; `frame-ancestors 'none'`; `connect-src`/`img-src` add exactly the public map hosts the map pages call: tiles.openfreemap.org, tile.openstreetmap.org, photon.komoot.io, nominatim.openstreetmap.org, routing.openstreetmap.de, router.project-osrm.org, overpass-api.de and overpass.private.coffee), `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`, and Hono's other secure headers. The static build on Vercel sends the same CSP and headers from `deploy/vercel/vercel.json`; the GitHub Pages copy cannot set headers | `app.ts`, `deploy/vercel/vercel.json` |
| Errors | Unhandled errors return a generic message with a request id. Stack traces are never sent. | `app.ts` |
| Secrets | **None are required.** No `.env` is needed, and no keys are in the repository, the Docker image or the frontend. `.env.example` lists only non-secret settings. The Docker image runs as the non-root `node` user. | `.env.example`, `Dockerfile` |
| Browser storage | Local mode keeps drafts and local scenarios in `localStorage`, behind try/catch. Signing out removes any account scenario from the local draft. | `web/state/*` |

## City data acquisition and the city workspace

* **Polite use of public OpenStreetMap services.** `scripts/city/acquire.ts`:
  * sends one request at a time, at least 4 s apart, with a descriptive User-Agent that includes the project URL;
  * makes at most 6 attempts per query, with exponential backoff, and honours `Retry-After`;
  * stops using an endpoint after two connection failures in a run;
  * splits a tile that keeps timing out into quadrants, rather than retrying the same heavy query.

  Downloads are cached and resumed from a manifest, so nothing is fetched twice. No credentials or API keys are used or stored.
* **Licensing.** The data is © OpenStreetMap contributors, ODbL. The bundle carries its attribution and provenance, and the UI and both printable reports show them.
* **Untrusted bundle input.** `decodeCityBundle` validates the format version, every array length and every index range before any use, and throws `CityFormatError` otherwise. The bundle is plain JSON with no executable content.
* **No sign-in.** By design, `/workspace` needs no account and stores nothing on the server. Scenario, coverage and cost inputs live only in the page's memory.
* **No fabricated figures.** Every number the city workspace shows is either an engine result for the bundled data or a user input labelled as an assumption. This covers profile speeds, turn penalties, fleet speeds, fuel, price, wage and the CO₂ factor. Building heights not tagged in OSM are flagged as estimates.

## Known limitations

* **No password reset.** It needs an email delivery service, which is not configured. The UI says so.
* **No account lockout** beyond rate limiting. There is no 2FA.
* Rate-limit counters are in memory, so they are per process and reset on restart.
* SQLite is single-writer. That is appropriate for a single instance only.
* CSP allows `'unsafe-inline'` for **styles**, because inline style attributes are used for dynamic sizes. Scripts are not allowed inline.
* The static (serverless) build has no accounts. Everything stays in that browser. Map acquisition there calls the public Overpass endpoints directly from the browser, under the same bbox and road-class limits.
* Map caches are files on the server's disk. They contain only public OpenStreetMap data.

## Verification

`apps/server/test/api.test.ts` (16 tests) and `maps.test.ts` (18 tests) cover:

* Hashing: no plaintext password is ever stored.
* Cookie flags.
* Generic login and registration errors.
* Session expiry.
* Password change revoking other sessions.
* CSRF rejection: missing token, forged token, cross-origin request.
* Body-size limits and malformed input.
* Rate limiting.
* Ownership on all eight scenario and run endpoints.
* Account deletion cascading to the user's data.
* Map acquisition, against mocked providers:
  * bbox and road-class validation before any request;
  * CSRF on acquisitions;
  * concurrency limits and request sharing;
  * Nominatim throttling;
  * error classification;
  * proxy credentials are never echoed.

## Reporting

Please open a private security advisory on the GitHub repository.
