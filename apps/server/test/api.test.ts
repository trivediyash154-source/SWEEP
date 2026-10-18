import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase, type Db } from '../src/db.js';
import { inlineSolver } from '../src/solver.js';
import { getExampleGraph } from '../src/engine.js';

type App = ReturnType<typeof createApp>;

/** Minimal cookie-jar client around app.request that mimics a browser. */
function client(app: App) {
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res: Response) => {
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';');
      const [k, ...rest] = pair!.split('=');
      const v = rest.join('=');
      const expired = attrs.some((a) => /max-age=0/i.test(a)) || v === '';
      if (expired) jar.delete(k!.trim());
      else jar.set(k!.trim(), v);
    }
  };
  const req = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { cookie: cookieHeader(), host: 'localhost', ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && jar.has('sweep_csrf') && !('x-csrf-token' in extra)) headers['x-csrf-token'] = jar.get('sweep_csrf')!;
    const res = await app.request(`http://localhost/api${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    store(res);
    const json = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    // Response bodies are asserted field by field in each test, so they are left untyped here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: json as any, res };
  };
  return { req, jar, init: () => req('GET', '/auth/csrf') };
}

let db: Db;
let app: App;
let clock = 1_800_000_000_000;

beforeEach(() => {
  db = openDatabase(':memory:');
  const config = { ...loadConfig({}), rateLimit: false, sessionTtlMs: 3600_000 };
  app = createApp({ db, config, solver: inlineSolver(), now: () => clock, log: () => {} });
});
afterEach(() => db.close());

const user = { email: 'asha@example.com', password: 'correct horse battery', displayName: 'Asha' };

describe('public API', () => {
  it('reports health with security headers', async () => {
    const c = client(app);
    const r = await c.req('GET', '/health');
    expect(r.status).toBe(200);
    expect(r.json.data.status).toBe('ok');
    expect(r.res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(r.res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('serves examples and optimises them with the authoritative engine', async () => {
    const c = client(app);
    await c.init();
    const list = await c.req('GET', '/examples');
    expect(list.json.data.length).toBeGreaterThan(5);
    const graph = (await c.req('GET', '/examples/konigsberg')).json.data;
    const r = await c.req('POST', '/optimize', { graph });
    expect(r.status).toBe(200);
    expect(r.json.data.ok).toBe(true);
    expect(r.json.data.oddVertexIds).toHaveLength(4);
    expect(r.json.data.checks.every((ch: { passed: boolean }) => ch.passed)).toBe(true);
  });

  it('returns validation diagnostics for unsolvable graphs', async () => {
    const c = client(app);
    await c.init();
    const r = await c.req('POST', '/optimize', { graph: getExampleGraph('twin-districts') });
    expect(r.json.data.ok).toBe(false);
    expect(r.json.data.validation.issues.map((i: { code: string }) => i.code)).toContain('REQUIRED_DISCONNECTED');
  });

  it('rejects malformed input without leaking internals', async () => {
    const c = client(app);
    await c.init();
    const bad = await c.req('POST', '/optimize', { graph: { vertices: 'nope', edges: [] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('INVALID_INPUT');
    const notJson = await app.request('http://localhost/api/optimize', {
      method: 'POST',
      headers: { host: 'localhost', 'content-type': 'application/json', cookie: `sweep_csrf=${c.jar.get('sweep_csrf')}`, 'x-csrf-token': c.jar.get('sweep_csrf')! },
      body: '{oops',
    });
    expect(notJson.status).toBe(400);
    expect(JSON.stringify(await notJson.json())).not.toMatch(/at\s+\w+\s+\(/);
  });

  it('enforces CSRF on state-changing requests', async () => {
    const c = client(app);
    const noToken = await c.req('POST', '/optimize', { graph: getExampleGraph('konigsberg') });
    expect(noToken.status).toBe(403);
    await c.init();
    const wrong = await c.req('POST', '/optimize', { graph: getExampleGraph('konigsberg') }, { 'x-csrf-token': 'forged' });
    expect(wrong.status).toBe(403);
    const crossOrigin = await c.req('POST', '/optimize', { graph: getExampleGraph('konigsberg') }, { origin: 'https://evil.example' });
    expect(crossOrigin.status).toBe(403);
  });

  it('rejects oversized bodies', async () => {
    const c = client(app);
    await c.init();
    const huge = { graph: { vertices: [], edges: [], description: 'x'.repeat(5 * 1024 * 1024) } };
    const r = await c.req('POST', '/optimize', huge);
    expect(r.status).toBe(413);
  });

  it('imports GeoJSON street networks', async () => {
    const c = client(app);
    await c.init();
    const geojson = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { name: 'A' }, geometry: { type: 'LineString', coordinates: [[73.85, 18.52], [73.851, 18.52], [73.851, 18.521], [73.85, 18.521], [73.85, 18.52]] } },
      ],
    };
    const r = await c.req('POST', '/import/geojson', { geojson });
    expect(r.status).toBe(200);
    expect(r.json.data.graph.edges.length).toBeGreaterThan(0);
    const bad = await c.req('POST', '/import/geojson', { geojson: { type: 'Nope' } });
    expect(bad.status).toBe(422);
  });
});

describe('authentication', () => {
  it('registers, signs in and out, and never stores plaintext passwords', async () => {
    const c = client(app);
    await c.init();
    const reg = await c.req('POST', '/auth/register', user);
    expect(reg.status).toBe(201);
    expect(c.jar.has('sweep_session')).toBe(true);
    const row = db.prepare('SELECT password_hash AS h FROM users').get() as { h: string };
    expect(row.h.startsWith('scrypt$')).toBe(true);
    expect(row.h).not.toContain(user.password);
    expect((await c.req('GET', '/auth/me')).json.data.user.email).toBe(user.email);
    await c.req('POST', '/auth/logout', {});
    expect((await c.req('GET', '/auth/me')).json.data.user).toBeNull();
    const bad = await c.req('POST', '/auth/login', { email: user.email, password: 'wrong password!!' });
    expect(bad.status).toBe(401);
    const unknown = await c.req('POST', '/auth/login', { email: 'nobody@example.com', password: 'whatever12345' });
    expect(unknown.status).toBe(401);
    expect(unknown.json.error.message).toBe(bad.json.error.message);
    const good = await c.req('POST', '/auth/login', { email: user.email, password: user.password });
    expect(good.status).toBe(200);
  });

  it('sets hardened session cookies', async () => {
    const c = client(app);
    await c.init();
    const reg = await c.req('POST', '/auth/register', user);
    const cookie = reg.res.headers.getSetCookie().find((s) => s.startsWith('sweep_session='))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('validates registration input and rejects duplicates generically', async () => {
    const c = client(app);
    await c.init();
    expect((await c.req('POST', '/auth/register', { ...user, password: 'short' })).status).toBe(400);
    expect((await c.req('POST', '/auth/register', { ...user, email: 'not-an-email' })).status).toBe(400);
    expect((await c.req('POST', '/auth/register', { ...user, password: 'password123' })).json.error.code).toBe('WEAK_PASSWORD');
    await c.req('POST', '/auth/register', user);
    const c2 = client(app);
    await c2.init();
    const dup = await c2.req('POST', '/auth/register', user);
    expect(dup.status).toBe(409);
    expect(dup.json.error.message).not.toContain(user.email);
  });

  it('expires sessions', async () => {
    const c = client(app);
    await c.init();
    await c.req('POST', '/auth/register', user);
    clock += 3600_001;
    expect((await c.req('GET', '/auth/me')).json.data.user).toBeNull();
    expect((await c.req('GET', '/scenarios')).status).toBe(401);
    clock -= 3600_001;
  });

  it('changes password and revokes other sessions', async () => {
    const a = client(app);
    await a.init();
    await a.req('POST', '/auth/register', user);
    const b = client(app);
    await b.init();
    await b.req('POST', '/auth/login', { email: user.email, password: user.password });
    const ch = await a.req('POST', '/account/password', { currentPassword: user.password, newPassword: 'a much better secret' });
    expect(ch.status).toBe(200);
    expect((await b.req('GET', '/auth/me')).json.data.user).toBeNull();
    expect((await a.req('GET', '/auth/me')).json.data.user).not.toBeNull();
  });

  it('rate-limits authentication attempts', async () => {
    const limited = createApp({ db, config: { ...loadConfig({}), rateLimit: true }, solver: inlineSolver(), log: () => {} });
    const c = client(limited);
    await c.init();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await c.req('POST', '/auth/login', { email: 'x@example.com', password: 'whatever12345' })).status;
    expect(last).toBe(429);
  });
});

describe('scenarios and runs', () => {
  const graph = () => getExampleGraph('old-town-grid')!;

  it('supports the full scenario lifecycle with stored, reproducible runs', async () => {
    const c = client(app);
    await c.init();
    await c.req('POST', '/auth/register', user);
    const created = await c.req('POST', '/scenarios', { name: 'Ward 7 sweep', graph: graph() });
    expect(created.status).toBe(201);
    const id = created.json.data.id as string;
    expect((await c.req('GET', '/scenarios')).json.data).toHaveLength(1);
    const renamed = await c.req('PUT', `/scenarios/${id}`, { name: 'Ward 7 — night sweep' });
    expect(renamed.json.data.name).toBe('Ward 7 — night sweep');
    const dup = await c.req('POST', `/scenarios/${id}/duplicate`, {});
    expect(dup.json.data.name).toContain('(copy)');
    const run = await c.req('POST', `/scenarios/${id}/runs`, {});
    expect(run.status).toBe(201);
    const runId = run.json.data.run.id as string;
    const again = await c.req('POST', `/scenarios/${id}/runs`, {});
    expect(again.json.data.result.route.steps).toEqual(run.json.data.result.route.steps);
    const fetched = await c.req('GET', `/runs/${runId}`);
    expect(fetched.json.data.record.route.totalDistance).toBe(run.json.data.result.route.totalDistance);
    expect((await c.req('GET', `/scenarios/${id}/runs`)).json.data).toHaveLength(2);
    const csv = await c.req('GET', `/runs/${runId}/export?format=route.csv`);
    expect(csv.res.headers.get('content-type')).toContain('text/csv');
    const lines = (csv.json as string).trim().split('\r\n');
    expect(lines.length - 1).toBe(run.json.data.result.route.steps.length);
    const lastCumulative = Number(lines.at(-1)!.split(',').at(-1));
    expect(lastCumulative).toBe(run.json.data.result.route.totalDistance);
    const exported = await c.req('GET', `/runs/${runId}/export?format=json`);
    expect(exported.json.result.route.totalDistance).toBe(run.json.data.result.route.totalDistance);
    expect((await c.req('DELETE', `/scenarios/${id}`)).status).toBe(200);
    expect((await c.req('GET', `/scenarios/${id}`)).status).toBe(404);
    expect((await c.req('GET', `/runs/${runId}`)).status).toBe(404);
  });

  it('enforces ownership on every scenario and run endpoint', async () => {
    const a = client(app);
    await a.init();
    await a.req('POST', '/auth/register', user);
    const s = (await a.req('POST', '/scenarios', { name: 'Private', graph: graph() })).json.data.id as string;
    const runId = (await a.req('POST', `/scenarios/${s}/runs`, {})).json.data.run.id as string;
    const b = client(app);
    await b.init();
    await b.req('POST', '/auth/register', { ...user, email: 'ravi@example.com', displayName: 'Ravi' });
    expect((await b.req('GET', '/scenarios')).json.data).toEqual([]);
    for (const [m, p, body] of [
      ['GET', `/scenarios/${s}`],
      ['PUT', `/scenarios/${s}`, { name: 'hijack' }],
      ['DELETE', `/scenarios/${s}`],
      ['POST', `/scenarios/${s}/duplicate`, {}],
      ['POST', `/scenarios/${s}/runs`, {}],
      ['GET', `/scenarios/${s}/runs`],
      ['GET', `/runs/${runId}`],
      ['GET', `/runs/${runId}/export?format=json`],
    ] as const) {
      const r = await b.req(m, p, body);
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    const anon = client(app);
    await anon.init();
    expect((await anon.req('GET', `/scenarios/${s}`)).status).toBe(401);
    expect((await a.req('GET', `/scenarios/${s}`)).json.data.name).toBe('Private');
  });

  it('deleting an account removes its data', async () => {
    const c = client(app);
    await c.init();
    await c.req('POST', '/auth/register', user);
    await c.req('POST', '/scenarios', { name: 'Gone soon', graph: graph() });
    expect((await c.req('DELETE', '/account', { password: 'wrong one!!' })).status).toBe(401);
    expect((await c.req('DELETE', '/account', { password: user.password })).status).toBe(200);
    expect((db.prepare('SELECT COUNT(*) AS n FROM scenarios').get() as { n: number }).n).toBe(0);
  });
});
