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
| Computation limits | At most 600 odd vertices (O(k³) matching). Every optimisation runs in a separate `worker_thread`, which is terminated after 20 s and returns `COMPUTATION_TIMEOUT`. | `solver.ts` |
| File parsing | Only `JSON.parse`; never `eval`. GeoJSON has feature, coordinate and range limits. Imports are previewed and validated before loading. | `engine/geojson.ts`, `engine/io.ts` |
| CSV exports | Cells starting with `= + - @ \t \r` are prefixed with `'`, and quoting follows RFC 4180 | `engine/io.ts` |
| Headers | CSP (`default-src 'self'`; no inline scripts; `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `X-Content-Type-Options: nosniff`, and Hono's other secure headers | `app.ts` |
| Errors | Unhandled errors return a generic message with a request id. Stack traces are never sent. | `app.ts` |
| Secrets | **None are required.** No `.env` is needed, and no keys are in the repository or the frontend. | – |
| Browser storage | Local mode keeps drafts and local scenarios in `localStorage`, behind try/catch. Signing out removes any account scenario from the local draft. | `web/state/*` |

## Known limitations

* **No password reset.** It needs an email delivery service, which is not configured. The UI says so.
* **No account lockout** beyond rate limiting. There is no 2FA.
* Rate-limit counters are in memory, so they are per process and reset on restart.
* SQLite is single-writer. That is appropriate for a single instance only.
* CSP allows `'unsafe-inline'` for **styles**, because inline style attributes are used for dynamic sizes. Scripts are not allowed inline.
* The static (serverless) build has no accounts. Everything stays in that browser.

## Verification

`apps/server/test/api.test.ts` (16 tests) covers:

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

## Reporting

Please open a private security advisory on the GitHub repository.
