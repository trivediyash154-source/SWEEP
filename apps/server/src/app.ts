import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { randomUUID } from 'node:crypto';
import { z, type ZodType } from 'zod';
import {
  ENGINE_VERSION,
  EXAMPLES_META,
  getExampleGraph,
  geojsonToGraph,
  GeoJsonImportError,
  validateGraph,
  routeToCsv,
  edgesToCsv,
  type Graph,
  type OptimizationRecord,
} from './engine.js';
import type { Db } from './db.js';
import type { ServerConfig } from './config.js';
import type { Solver } from './solver.js';
import { ApiError, fail, ok } from './http.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  csrfProtection,
  getDummyHash,
  hashPassword,
  newToken,
  rateLimiter,
  sha256,
  verifyPassword,
} from './security.js';
import {
  COMMON_PASSWORDS,
  accountDeleteSchema,
  accountUpdateSchema,
  credentialsSchema,
  geojsonImportSchema,
  graphSchema,
  optimizeSchema,
  passwordChangeSchema,
  registerSchema,
  runCreateSchema,
  scenarioCreateSchema,
  scenarioUpdateSchema,
} from './schemas.js';

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: number;
}

type Env = { Variables: { user: AuthUser | null; requestId: string } };

export interface AppDeps {
  db: Db;
  config: ServerConfig;
  solver: Solver;
  /** Override the clock (tests). */
  now?: () => number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

async function parseBody<S extends ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 4 MB.');
  }
  if (text.length > MAX_BODY_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 4 MB.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'The request body must be valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new ApiError(400, 'INVALID_INPUT', issues[0] ? `${issues[0].path ? `${issues[0].path}: ` : ''}${issues[0].message}` : 'Invalid input.', issues);
  }
  return parsed.data;
}

function summarize(record: OptimizationRecord) {
  return {
    totalDistance: record.route.totalDistance,
    requiredDistance: record.route.requiredDistance,
    repeatedDistance: record.route.repeatedDistance,
    oddVertexCount: record.oddVertexIds.length,
    steps: record.route.steps.length,
    optimal: record.algorithm.optimal,
    checksPassed: record.checks.every((ch) => ch.passed),
    engineVersion: record.engine.version,
  };
}

export function createApp(deps: AppDeps): Hono<Env> {
  const { db, config, solver } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((msg, meta) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...meta })));
  const app = new Hono<Env>();

  const clientIp = (c: Context): string => {
    if (config.trustProxy) {
      const fwd = c.req.header('x-forwarded-for');
      if (fwd) return fwd.split(',')[0]!.trim();
    }
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    return incoming?.socket?.remoteAddress ?? 'local';
  };

  // ---- Global middleware ------------------------------------------------
  app.use('*', async (c, next) => {
    c.set('requestId', randomUUID());
    await next();
  });
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
      referrerPolicy: 'same-origin',
      xFrameOptions: 'DENY',
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.onError((err, c) => {
    if (err instanceof ApiError) return fail(c, err);
    log('unhandled_error', { requestId: c.get('requestId'), path: c.req.path, error: err instanceof Error ? err.message : String(err) });
    return fail(c, new ApiError(500, 'INTERNAL', `Unexpected server error (reference ${c.get('requestId')}).`));
  });

  const api = new Hono<Env>();

  api.use('*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 4 MB.')) }));
  api.use('*', rateLimiter({ key: 'all', windowMs: 60_000, max: 600, enabled: config.rateLimit, clientIp }));
  api.use('*', csrfProtection);

  // ---- Session resolution ------------------------------------------------
  const selectSession = db.prepare(
    `SELECT u.id, u.email, u.display_name AS displayName, u.created_at AS createdAt, s.expires_at AS expiresAt
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  );
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  api.use('*', async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    let user: AuthUser | null = null;
    if (token) {
      const row = selectSession.get(sha256(token)) as (AuthUser & { expiresAt: number }) | undefined;
      if (row && row.expiresAt > now()) user = { id: row.id, email: row.email, displayName: row.displayName, createdAt: row.createdAt };
      else if (row) deleteSession.run(sha256(token));
    }
    c.set('user', user);
    await next();
  });

  const requireUser = (c: Context<Env>): AuthUser => {
    const u = c.get('user');
    if (!u) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to continue. Your session may have expired.');
    return u;
  };

  const cookieBase = { path: '/', httpOnly: true, sameSite: 'Lax' as const, secure: config.secureCookies };
  const startSession = (c: Context, userId: string): void => {
    const token = newToken();
    const expires = now() + config.sessionTtlMs;
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, now(), expires);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').run(userId, now());
    setCookie(c, SESSION_COOKIE, token, { ...cookieBase, maxAge: Math.floor(config.sessionTtlMs / 1000) });
  };

  // ---- Public endpoints --------------------------------------------------
  api.get('/health', (c) => {
    const row = db.prepare('SELECT 1 AS up').get() as { up: number };
    return ok(c, { status: 'ok', engine: ENGINE_VERSION, database: row.up === 1 ? 'ok' : 'error', time: new Date(now()).toISOString() });
  });

  api.get('/auth/csrf', (c) => {
    let token = getCookie(c, CSRF_COOKIE);
    if (!token) {
      token = newToken();
      setCookie(c, CSRF_COOKIE, token, { path: '/', httpOnly: false, sameSite: 'Lax', secure: config.secureCookies, maxAge: 30 * 24 * 3600 });
    }
    return ok(c, { token });
  });

  api.get('/examples', (c) => ok(c, EXAMPLES_META));
  api.get('/examples/:id', (c) => {
    const g = getExampleGraph(c.req.param('id'));
    if (!g) throw new ApiError(404, 'NOT_FOUND', 'No such example.');
    return ok(c, g);
  });

  const optimizeLimiter = rateLimiter({ key: 'optimize', windowMs: 60_000, max: 60, enabled: config.rateLimit, clientIp });

  api.post('/validate', async (c) => {
    const body = await parseBody(c, optimizeSchema);
    return ok(c, validateGraph(body.graph as Graph, { depotId: body.depotId ?? body.graph.depotId ?? null }));
  });

  api.post('/optimize', optimizeLimiter, async (c) => {
    const body = await parseBody(c, optimizeSchema);
    const result = await solver.solve(body.graph as Graph, body.depotId ?? body.graph.depotId ?? null);
    return ok(c, result);
  });

  api.post('/import/geojson', async (c) => {
    const body = await parseBody(c, geojsonImportSchema);
    try {
      const report = geojsonToGraph(body.geojson, body.name ?? 'Imported network');
      return ok(c, { ...report, validation: validateGraph(report.graph) });
    } catch (err) {
      if (err instanceof GeoJsonImportError) throw new ApiError(422, 'GEOJSON_INVALID', err.message);
      throw err;
    }
  });

  // ---- Authentication ----------------------------------------------------
  const authLimiter = rateLimiter({ key: 'auth', windowMs: 60_000, max: 10, enabled: config.rateLimit, clientIp });

  api.post('/auth/register', authLimiter, async (c) => {
    const body = await parseBody(c, registerSchema);
    if (COMMON_PASSWORDS.has(body.password.toLowerCase())) throw new ApiError(400, 'WEAK_PASSWORD', 'That password is too common. Choose a less predictable one.');
    const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(body.email);
    if (exists) {
      // Deliberately generic: do not confirm which emails are registered.
      throw new ApiError(409, 'REGISTRATION_FAILED', 'We could not create an account with these details. If you already have an account, sign in instead.');
    }
    const user: AuthUser = { id: randomUUID(), email: body.email, displayName: body.displayName, createdAt: now() };
    db.prepare('INSERT INTO users (id, email, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, user.email, user.displayName, await hashPassword(body.password), user.createdAt);
    startSession(c, user.id);
    log('user_registered', { userId: user.id });
    return ok(c, { user }, 201);
  });

  api.post('/auth/login', authLimiter, async (c) => {
    const body = await parseBody(c, credentialsSchema);
    const row = db.prepare('SELECT id, email, display_name AS displayName, created_at AS createdAt, password_hash AS hash FROM users WHERE email = ?').get(body.email) as
      | (AuthUser & { hash: string })
      | undefined;
    const valid = await verifyPassword(body.password, row?.hash ?? (await getDummyHash()));
    if (!row || !valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    startSession(c, row.id);
    return ok(c, { user: { id: row.id, email: row.email, displayName: row.displayName, createdAt: row.createdAt } });
  });

  api.post('/auth/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deleteSession.run(sha256(token));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return ok(c, { signedOut: true });
  });

  api.get('/auth/me', (c) => ok(c, { user: c.get('user') }));

  api.patch('/account', async (c) => {
    const user = requireUser(c);
    const body = await parseBody(c, accountUpdateSchema);
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(body.displayName, user.id);
    return ok(c, { user: { ...user, displayName: body.displayName } });
  });

  api.post('/account/password', authLimiter, async (c) => {
    const user = requireUser(c);
    const body = await parseBody(c, passwordChangeSchema);
    const row = db.prepare('SELECT password_hash AS hash FROM users WHERE id = ?').get(user.id) as { hash: string };
    if (!(await verifyPassword(body.currentPassword, row.hash))) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.');
    if (COMMON_PASSWORDS.has(body.newPassword.toLowerCase())) throw new ApiError(400, 'WEAK_PASSWORD', 'That password is too common. Choose a less predictable one.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(body.newPassword), user.id);
    // Revoke every other session; keep the caller signed in on a fresh session.
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    startSession(c, user.id);
    return ok(c, { changed: true });
  });

  api.delete('/account', authLimiter, async (c) => {
    const user = requireUser(c);
    const body = await parseBody(c, accountDeleteSchema);
    const row = db.prepare('SELECT password_hash AS hash FROM users WHERE id = ?').get(user.id) as { hash: string };
    if (!(await verifyPassword(body.password, row.hash))) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Password is incorrect.');
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return ok(c, { deleted: true });
  });

  // ---- Scenarios (owner-scoped) -------------------------------------------
  const loadScenario = (user: AuthUser, id: string): { id: string; name: string; graph: Graph; createdAt: number; updatedAt: number } => {
    const row = db.prepare('SELECT id, name, graph_json AS graph, created_at AS createdAt, updated_at AS updatedAt FROM scenarios WHERE id = ? AND owner_id = ?').get(id, user.id) as
      | { id: string; name: string; graph: string; createdAt: number; updatedAt: number }
      | undefined;
    // 404 (not 403) so that other users' scenario ids are not confirmed.
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Scenario not found.');
    return { ...row, graph: JSON.parse(row.graph) as Graph };
  };

  const MAX_SCENARIOS = 200;

  api.get('/scenarios', (c) => {
    const user = requireUser(c);
    const rows = db
      .prepare('SELECT id, name, graph_json AS graph, created_at AS createdAt, updated_at AS updatedAt FROM scenarios WHERE owner_id = ? ORDER BY updated_at DESC')
      .all(user.id) as { id: string; name: string; graph: string; createdAt: number; updatedAt: number }[];
    return ok(
      c,
      rows.map((r) => {
        const g = JSON.parse(r.graph) as Graph;
        return { id: r.id, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt, vertexCount: g.vertices.length, edgeCount: g.edges.length };
      }),
    );
  });

  api.post('/scenarios', async (c) => {
    const user = requireUser(c);
    const body = await parseBody(c, scenarioCreateSchema);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM scenarios WHERE owner_id = ?').get(user.id) as { n: number }).n;
    if (count >= MAX_SCENARIOS) throw new ApiError(409, 'QUOTA', `You can keep up to ${MAX_SCENARIOS} scenarios.`);
    const id = randomUUID();
    const t = now();
    db.prepare('INSERT INTO scenarios (id, owner_id, name, graph_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, user.id, body.name, JSON.stringify(body.graph), t, t);
    return ok(c, { id, name: body.name, graph: body.graph, createdAt: t, updatedAt: t }, 201);
  });

  api.get('/scenarios/:id', (c) => ok(c, loadScenario(requireUser(c), c.req.param('id'))));

  api.put('/scenarios/:id', async (c) => {
    const user = requireUser(c);
    const current = loadScenario(user, c.req.param('id'));
    const body = await parseBody(c, scenarioUpdateSchema);
    const name = body.name ?? current.name;
    const graph = body.graph ?? current.graph;
    const t = now();
    db.prepare('UPDATE scenarios SET name = ?, graph_json = ?, updated_at = ? WHERE id = ? AND owner_id = ?').run(name, JSON.stringify(graph), t, current.id, user.id);
    return ok(c, { id: current.id, name, graph, createdAt: current.createdAt, updatedAt: t });
  });

  api.post('/scenarios/:id/duplicate', (c) => {
    const user = requireUser(c);
    const current = loadScenario(user, c.req.param('id'));
    const id = randomUUID();
    const t = now();
    const name = `${current.name} (copy)`.slice(0, 120);
    db.prepare('INSERT INTO scenarios (id, owner_id, name, graph_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, user.id, name, JSON.stringify(current.graph), t, t);
    return ok(c, { id, name, graph: current.graph, createdAt: t, updatedAt: t }, 201);
  });

  api.delete('/scenarios/:id', (c) => {
    const user = requireUser(c);
    const current = loadScenario(user, c.req.param('id'));
    db.prepare('DELETE FROM scenarios WHERE id = ? AND owner_id = ?').run(current.id, user.id);
    return ok(c, { deleted: true });
  });

  api.post('/scenarios/:id/runs', optimizeLimiter, async (c) => {
    const user = requireUser(c);
    const scenario = loadScenario(user, c.req.param('id'));
    const body = await parseBody(c, runCreateSchema);
    const graphCheck = graphSchema.safeParse(scenario.graph);
    if (!graphCheck.success) throw new ApiError(422, 'INVALID_SCENARIO', 'Stored scenario graph is invalid.');
    const depotId = body.depotId ?? scenario.graph.depotId ?? null;
    const result = await solver.solve(scenario.graph, depotId);
    if (!result.ok) return ok(c, { run: null, result });
    const id = randomUUID();
    const t = now();
    db.prepare(
      'INSERT INTO runs (id, scenario_id, owner_id, engine_version, graph_hash, config_json, graph_json, summary_json, record_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, scenario.id, user.id, result.engine.version, result.input.graphHash, JSON.stringify({ depotId: result.input.depotId }), JSON.stringify(scenario.graph), JSON.stringify(summarize(result)), JSON.stringify(result), t);
    return ok(c, { run: { id, scenarioId: scenario.id, createdAt: t, summary: summarize(result) }, result }, 201);
  });

  api.get('/scenarios/:id/runs', (c) => {
    const user = requireUser(c);
    const scenario = loadScenario(user, c.req.param('id'));
    const rows = db
      .prepare('SELECT id, engine_version AS engineVersion, graph_hash AS graphHash, summary_json AS summary, created_at AS createdAt FROM runs WHERE scenario_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(scenario.id, user.id) as { id: string; engineVersion: string; graphHash: string; summary: string; createdAt: number }[];
    return ok(c, rows.map((r) => ({ ...r, scenarioId: scenario.id, summary: JSON.parse(r.summary) as unknown })));
  });

  const loadRun = (user: AuthUser, id: string) => {
    const row = db
      .prepare('SELECT r.id, r.scenario_id AS scenarioId, s.name AS scenarioName, r.graph_json AS graph, r.record_json AS record, r.created_at AS createdAt FROM runs r JOIN scenarios s ON s.id = r.scenario_id WHERE r.id = ? AND r.owner_id = ?')
      .get(id, user.id) as { id: string; scenarioId: string; scenarioName: string; graph: string; record: string; createdAt: number } | undefined;
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Run not found.');
    return { ...row, graph: JSON.parse(row.graph) as Graph, record: JSON.parse(row.record) as OptimizationRecord };
  };

  api.get('/runs/:id', (c) => ok(c, loadRun(requireUser(c), c.req.param('id'))));

  api.get('/runs/:id/export', (c) => {
    const run = loadRun(requireUser(c), c.req.param('id'));
    const format = c.req.query('format') ?? 'json';
    const base = `sweep-${run.scenarioName.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 40) || 'run'}-${run.id.slice(0, 8)}`;
    if (format === 'json') {
      c.header('Content-Disposition', `attachment; filename="${base}.json"`);
      return c.json({ format: 'sweep.run', version: 1, scenario: run.scenarioName, createdAt: new Date(run.createdAt).toISOString(), graph: run.graph, result: run.record });
    }
    if (format === 'route.csv' || format === 'edges.csv') {
      c.header('Content-Type', 'text/csv; charset=utf-8');
      c.header('Content-Disposition', `attachment; filename="${base}-${format}"`);
      return c.body(format === 'route.csv' ? routeToCsv(run.record, run.graph) : edgesToCsv(run.record, run.graph));
    }
    throw new ApiError(400, 'INVALID_FORMAT', 'Use format=json, route.csv or edges.csv.');
  });

  api.all('*', (c) => fail(c, new ApiError(404, 'NOT_FOUND', 'No such endpoint.')));

  app.route('/api', api);

  // ---- Static web app (production) -----------------------------------------
  if (config.staticDir) {
    const root = config.staticDir;
    app.use('/assets/*', async (c, next) => {
      await next();
      if (c.res.status === 200) c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    });
    app.use('*', serveStatic({ root }));
    app.get('*', serveStatic({ path: `${root}/index.html` }));
  }

  return app;
}
