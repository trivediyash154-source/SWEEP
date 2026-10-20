import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase, type Db } from '../src/db.js';
import { inlineSolver } from '../src/solver.js';
import { getExampleGraph, type Graph } from '../src/engine.js';

type App = ReturnType<typeof createApp>;

function client(app: App) {
  const jar = new Map<string, string>();
  const req = async (method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), host: 'localhost' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && jar.has('sweep_csrf')) headers['x-csrf-token'] = jar.get('sweep_csrf')!;
    const res = await app.request(`http://localhost/api${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const [k, ...rest] = pair!.split('=');
      jar.set(k!.trim(), rest.join('='));
    }
    const json = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are asserted field by field
    return { status: res.status, json: json as any };
  };
  return { req, init: () => req('GET', '/auth/csrf') };
}

let db: Db;
let app: App;
beforeEach(() => {
  db = openDatabase(':memory:');
  app = createApp({ db, config: { ...loadConfig({}), rateLimit: false }, solver: inlineSolver(), log: () => {} });
});
afterEach(() => db.close());

const oneway: Graph = {
  name: 'One-way triangle with a spur',
  vertices: [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 100, y: 0 },
    { id: 'c', x: 50, y: 80 },
  ],
  edges: [
    { id: 'ab', u: 'a', v: 'b', weight: 1, required: true, oneway: true },
    { id: 'bc', u: 'b', v: 'c', weight: 1, required: true },
    { id: 'ca', u: 'c', v: 'a', weight: 5, required: false, oneway: true },
  ],
  depotId: 'a',
};

describe('POST /api/route', () => {
  it('refuses one-way networks in undirected mode and explains why', async () => {
    const c = client(app);
    await c.init();
    const r = await c.req('POST', '/route', { graph: oneway });
    expect(r.json.data.ok).toBe(false);
    expect(r.json.data.validation.issues.map((i: { code: string }) => i.code)).toContain('ONEWAY_REQUIRES_DIRECTED');
    // The original endpoint keeps its undirected-only contract.
    expect((await c.req('POST', '/optimize', { graph: oneway })).json.data.ok).toBe(false);
  });

  it('solves one-way networks exactly in directed mode', async () => {
    const c = client(app);
    await c.init();
    const both = await c.req('POST', '/route', { graph: oneway, settings: { mode: 'directed', twoWay: 'both' } });
    expect(both.json.data.ok).toBe(true);
    expect(both.json.data.single.mode).toBe('directed');
    expect(both.json.data.single.route.totalDistance).toBe(9);
    expect(both.json.data.single.checks.every((ch: { passed: boolean }) => ch.passed)).toBe(true);
    const either = await c.req('POST', '/route', { graph: { ...oneway, routing: { mode: 'directed', twoWay: 'either' } } });
    expect(either.json.data.single.route.totalDistance).toBe(7);
    expect(either.json.data.single.algorithm.problem).toBe('mixed-chinese-postman-exact-enumeration');
  });

  it('plans a fleet and reports split failures without losing the single route', async () => {
    const c = client(app);
    await c.init();
    const graph = getExampleGraph('meridian-district')!;
    const r = await c.req('POST', '/route', { graph, settings: { vehicles: 3 } });
    expect(r.json.data.fleet.activeVehicles).toBe(3);
    expect(r.json.data.fleet.coverage.missingEdgeIds).toEqual([]);
    expect(r.json.data.fleet.algorithm.ratioBound).toBeCloseTo(5 / 3, 9);
    const bad = await c.req('POST', '/route', { graph, settings: { vehicles: 3, maxRouteLength: 1 } });
    expect(bad.json.data.fleet).toBeNull();
    expect(bad.json.data.fleetIssues[0].code).toBe('FLEET_LIMIT_INFEASIBLE');
    const invalid = await c.req('POST', '/route', { graph, settings: { vehicles: 2.5 } });
    expect(invalid.status).toBe(400);
  });

  it('stores runs with their settings and exports every vehicle route', async () => {
    const c = client(app);
    await c.init();
    await c.req('POST', '/auth/register', { email: 'fleet@example.com', password: 'a long enough password', displayName: 'Fleet' });
    const s = await c.req('POST', '/scenarios', { name: 'Meridian fleet', graph: getExampleGraph('meridian-district') });
    const run = await c.req('POST', `/scenarios/${s.json.data.id}/runs`, { settings: { vehicles: 2 } });
    expect(run.status).toBe(201);
    expect(run.json.data.run.summary.vehicles).toBe(2);
    expect(run.json.data.run.summary.makespan).toBe(run.json.data.routing.fleet.makespan);
    const id = run.json.data.run.id as string;
    const fetched = await c.req('GET', `/runs/${id}`);
    expect(fetched.json.data.routing.fleet.routes).toHaveLength(2);
    const csv = await c.req('GET', `/runs/${id}/export?format=fleet.csv`);
    const rows = (csv.json as string).trim().split('\r\n').slice(1);
    const steps = run.json.data.routing.fleet.routes.reduce((n: number, r: { steps: unknown[] }) => n + r.steps.length, 0);
    expect(rows).toHaveLength(steps);
    expect(new Set(rows.map((l) => l.split(',')[0]))).toEqual(new Set(['1', '2']));
    expect(rows.every((l) => l.endsWith(',true'))).toBe(true);
    const json = await c.req('GET', `/runs/${id}/export?format=json`);
    expect(json.json.version).toBe(2);
    expect(json.json.settings.vehicles).toBe(2);
    expect(json.json.fleet.totalDistance).toBe(run.json.data.routing.fleet.totalDistance);
  });
});
