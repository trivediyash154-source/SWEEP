import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { openDatabase, type Db } from '../src/db.js';
import { inlineSolver } from '../src/solver.js';
import { classifyFetchError, redact, SWEEP_USER_AGENT } from '../src/maps.js';
import { buildOverpassQuery, DRIVABLE_ROAD_CLASSES } from '../src/engine.js';

type App = ReturnType<typeof createApp>;

/** Minimal cookie-jar client around app.request that mimics a browser (same pattern as api.test.ts). */
function client(app: App) {
  const jar = new Map<string, string>();
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const store = (res: Response) => {
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const [k, ...rest] = pair!.split('=');
      jar.set(k!.trim(), rest.join('='));
    }
  };
  const req = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = { cookie: cookieHeader(), host: 'localhost', ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && jar.has('sweep_csrf') && !('x-csrf-token' in extra)) headers['x-csrf-token'] = jar.get('sweep_csrf')!;
    const res = await app.request(`http://localhost/api${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    store(res);
    const json = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    // Response bodies are asserted field by field, so they are left untyped here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: json as any, res };
  };
  return { req, jar, init: () => req('GET', '/auth/csrf') };
}

// Hand-made Overpass-shaped fixture with obviously fake ids (a test input, not map data):
// a two-way street 1–2–3 crossed by a one-way street 4→2→5, inside the Zurich test bbox.
const FIXTURE = {
  version: 0.6,
  elements: [
    { type: 'node', id: 1, lat: 47.371, lon: 8.541 },
    { type: 'node', id: 2, lat: 47.371, lon: 8.542 },
    { type: 'node', id: 3, lat: 47.371, lon: 8.543 },
    { type: 'node', id: 4, lat: 47.3705, lon: 8.542 },
    { type: 'node', id: 5, lat: 47.3715, lon: 8.542 },
    { type: 'way', id: 100, nodes: [1, 2, 3], tags: { highway: 'residential', name: 'Test Street' } },
    { type: 'way', id: 101, nodes: [4, 2, 5], tags: { highway: 'service', oneway: 'yes' } },
  ],
};
const BBOX_CH: [number, number, number, number] = [47.37, 8.54, 47.3735, 8.5455];
const BBOX_PUNE: [number, number, number, number] = [18.516, 73.84, 18.519, 73.844];
const A = 'https://overpass-a.test/api/interpreter';
const B = 'https://overpass-b.test/api/interpreter';
const CH = 'https://overpass.osm.ch/api/interpreter';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const netError = (code: string, message: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
interface Call {
  url: string;
  init?: RequestInit;
}

let db: Db;
let cacheDir: string;
let clock = 1_800_000_000_000;
const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];

function setup(opts: { config?: Partial<ServerConfig>; byHost?: Record<string, Handler> } = {}) {
  const calls: Call[] = [];
  const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    const handler = opts.byHost?.[new URL(url).host];
    if (!handler) throw netError('ENOTFOUND', `getaddrinfo ENOTFOUND ${new URL(url).host}`);
    return handler(url, init);
  };
  const config: ServerConfig = { ...loadConfig({}), rateLimit: false, mapCacheDir: cacheDir, overpassEndpoints: [A, B], ...opts.config };
  const app = createApp({ db, config, solver: inlineSolver(), now: () => clock, log: (msg, meta) => logs.push({ msg, ...(meta ? { meta } : {}) }), fetch: fetchMock as typeof fetch });
  return { app, calls, c: client(app) };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  cacheDir = mkdtempSync(join(tmpdir(), 'sweep-map-cache-'));
  logs.length = 0;
});
afterEach(() => {
  db.close();
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('map acquisition', () => {
  it('reports its status without exposing absolute paths', async () => {
    const { c } = setup();
    const r = await c.req('GET', '/maps/status');
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ enabled: true, endpoints: [A, B], maxAreaKm2: 4, attribution: '© OpenStreetMap contributors', license: 'ODbL 1.0' });
    expect(JSON.stringify(r.json.data)).not.toContain(cacheDir);
    expect(loadConfig({}).overpassEndpoints).toEqual([
      'https://overpass-api.de/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
      'https://overpass.osm.ch/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    ]);
    expect(loadConfig({ SWEEP_OVERPASS_ENDPOINTS: `${B}, not a url, https://user:pw@x.test/api` }).overpassEndpoints).toEqual([B]);
  });

  it('acquires, converts and records provenance', async () => {
    const { c, calls } = setup({ byHost: { 'overpass-a.test': () => json(FIXTURE) } });
    await c.init();
    const r = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH, name: 'Test area' });
    expect(r.status).toBe(200);
    const d = r.json.data;
    expect(d.cached).toBe(false);
    expect(d.graph.name).toBe('Test area');
    expect(d.graph.edges).toHaveLength(4);
    expect(d.graph.edges.filter((e: { oneway?: boolean }) => e.oneway)).toHaveLength(2);
    expect(d.graph.routing).toEqual({ mode: 'directed', twoWay: 'both' });
    expect(d.graph.source).toMatchObject({
      kind: 'live-acquisition',
      provider: 'OpenStreetMap via Overpass API (overpass-a.test)',
      endpoint: A,
      retrievedAt: new Date(clock).toISOString(),
      bbox: BBOX_CH,
      attribution: '© OpenStreetMap contributors',
      license: 'ODbL 1.0',
      cached: false,
    });
    expect(d.report.stats).toMatchObject({ vertices: 5, edges: 4, onewayEdges: 2 });
    expect(d.report.roadClassesFound).toEqual({ residential: 1, service: 1 });
    expect(d.attempts).toEqual([expect.objectContaining({ endpoint: A, host: 'overpass-a.test', ok: true, status: 200 })]);
    // the upstream request identifies SWEEP and carries the whitelisted query
    expect(calls).toHaveLength(1);
    const init = calls[0]!.init!;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(SWEEP_USER_AGENT);
    const sent = new URLSearchParams(String(init.body)).get('data');
    expect(sent).toBe(buildOverpassQuery(BBOX_CH, DRIVABLE_ROAD_CLASSES));
    expect(d.query).toBe(sent);
  });

  it('falls back to the next provider (first 504, second OK)', async () => {
    // the 504 body has the shape of Overpass's HTML error page
    const busyPage = '<html><body><p><strong style="color:#FF0000">Error</strong>: runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::timeout. The server is probably too busy to handle your request. </p></body></html>';
    const { c } = setup({ byHost: { 'overpass-a.test': () => new Response(busyPage, { status: 504, headers: { 'content-type': 'text/html' } }), 'overpass-b.test': () => json(FIXTURE) } });
    await c.init();
    const r = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH, roadClasses: ['residential', 'service'] });
    expect(r.status).toBe(200);
    expect(r.json.data.attempts).toEqual([
      expect.objectContaining({ endpoint: A, ok: false, status: 504, errorClass: 'busy' }),
      expect.objectContaining({ endpoint: B, ok: true, status: 200 }),
    ]);
    expect(r.json.data.attempts[0].error).toMatch(/Provider said: "runtime error: .*too busy/);
    expect(r.json.data.graph.source.endpoint).toBe(B);
    expect(r.json.data.graph.source.roadClasses).toEqual(['residential', 'service']);
  });

  it('returns 502 with every attempt when all providers fail', async () => {
    const { c } = setup({ byHost: { 'overpass-a.test': () => json({}, 429) } });
    await c.init();
    const r = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH });
    expect(r.status).toBe(502);
    expect(r.json.error.code).toBe('MAP_PROVIDERS_UNAVAILABLE');
    expect(r.json.error.message).toMatch(/GeoJSON/);
    expect(r.json.error.message).toMatch(/Zurich Altstadt sample/);
    expect(r.json.error.details.attempts.map((a: { errorClass: string }) => a.errorClass)).toEqual(['rate-limited', 'dns']);
  });

  it('classifies DNS, TLS, proxy, timeout, size and format failures from the real error', async () => {
    const hosts = ['dns', 'tls', 'refused', 'proxy', 'timeout', 'http407', 'html', 'notoverpass', 'remark', 'big'].map((h) => `${h}.test`);
    const { c } = setup({
      config: { overpassEndpoints: hosts.map((h) => `https://${h}/api/interpreter`) },
      byHost: {
        'dns.test': () => {
          throw netError('EAI_AGAIN', 'getaddrinfo EAI_AGAIN dns.test');
        },
        'tls.test': () => {
          throw netError('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate');
        },
        'refused.test': () => {
          throw netError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:443');
        },
        'proxy.test': () => {
          throw Object.assign(new TypeError('fetch failed'), { cause: new Error('Proxy response (403) !== 200 when HTTP Tunneling') });
        },
        'timeout.test': () => {
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        },
        'http407.test': () => json({}, 407),
        'html.test': () => new Response('<html>busy</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
        'notoverpass.test': () => json({ hello: 'world' }),
        'remark.test': () => json({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.' }),
        'big.test': () => new Response('{}', { status: 200, headers: { 'content-length': String(30 * 1024 * 1024) } }),
      },
    });
    await c.init();
    const r = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH });
    expect(r.status).toBe(502);
    expect(r.json.error.details.attempts.map((a: { errorClass: string }) => a.errorClass)).toEqual([
      'dns',
      'tls',
      'proxy-refused',
      'proxy-refused',
      'timeout',
      'proxy-refused',
      'invalid-json',
      'invalid-response',
      'provider-error',
      'too-large',
    ]);
    expect(r.json.error.details.attempts[0].error).toMatch(/DNS lookup failed.*EAI_AGAIN/);
  });

  it('skips overpass.osm.ch outside Switzerland and uses it inside', async () => {
    const outside = setup({ config: { overpassEndpoints: [CH, A] }, byHost: { 'overpass-a.test': () => json(FIXTURE), 'overpass.osm.ch': () => json(FIXTURE) } });
    await outside.c.init();
    const r = await outside.c.req('POST', '/maps/acquire', { bbox: BBOX_PUNE });
    // the fixture's streets lie outside the Pune bbox, but the converter does not clip; what matters is who was asked
    expect(r.json.data.attempts[0]).toMatchObject({ endpoint: CH, ok: false, skipped: true, errorClass: 'out-of-coverage' });
    expect(outside.calls.map((x) => new URL(x.url).host)).toEqual(['overpass-a.test']);
    const inside = setup({ config: { overpassEndpoints: [CH, A] }, byHost: { 'overpass.osm.ch': () => json(FIXTURE) } });
    await inside.c.init();
    const r2 = await inside.c.req('POST', '/maps/acquire', { bbox: BBOX_CH });
    expect(r2.json.data.graph.source.provider).toBe('OpenStreetMap via Overpass API (overpass.osm.ch)');
  });

  it('validates the bbox and road classes before any network request', async () => {
    const { c, calls } = setup({ byHost: { 'overpass-a.test': () => json(FIXTURE) } });
    await c.init();
    const inverted = await c.req('POST', '/maps/acquire', { bbox: [47.3735, 8.54, 47.37, 8.5455] });
    expect(inverted.status).toBe(400);
    expect(inverted.json.error.code).toBe('INVALID_BBOX');
    expect(inverted.json.error.message).toMatch(/South .* must be less than north/);
    const large = await c.req('POST', '/maps/acquire', { bbox: [47.3, 8.4, 47.45, 8.65] });
    expect(large.status).toBe(400);
    expect(large.json.error.message).toMatch(/limit is 4 km²/);
    const malformed = await c.req('POST', '/maps/acquire', { bbox: [47.3, 8.4, 47.45] });
    expect(malformed.json.error.code).toBe('INVALID_INPUT');
    const unknown = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH, roadClasses: ['residential', 'motorway2'] });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.code).toBe('INVALID_ROAD_CLASS');
    const injection = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH, roadClasses: ['residential)$"];node(1);out;//'] });
    expect(injection.json.error.code).toBe('INVALID_ROAD_CLASS');
    expect(calls).toHaveLength(0);
  });

  it('serves repeated requests from the cache with the original retrieval time', async () => {
    const { c, calls } = setup({ byHost: { 'overpass-a.test': () => json(FIXTURE) } });
    await c.init();
    const first = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH });
    expect(first.json.data.cached).toBe(false);
    const key = createHash('sha256').update(first.json.data.query).digest('hex');
    expect(readdirSync(cacheDir)).toEqual([`${key}.json`]);
    const t0 = clock;
    clock += 3 * 24 * 3600 * 1000;
    const second = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH, keepAllComponents: true });
    expect(second.status).toBe(200);
    expect(second.json.data.cached).toBe(true);
    expect(second.json.data.attempts).toEqual([]);
    expect(second.json.data.graph.source).toMatchObject({ cached: true, retrievedAt: new Date(t0).toISOString(), endpoint: A });
    expect(calls).toHaveLength(1);
    // after the 7-day TTL the provider is asked again
    clock += 5 * 24 * 3600 * 1000;
    const third = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH });
    expect(third.json.data.cached).toBe(false);
    expect(calls).toHaveLength(2);
    clock = t0;
  });

  it('keeps working when the cache directory cannot be created', async () => {
    const blocker = join(cacheDir, 'a-file');
    writeFileSync(blocker, 'not a directory');
    const { c } = setup({ config: { mapCacheDir: join(blocker, 'cache') }, byHost: { 'overpass-a.test': () => json(FIXTURE) } });
    await c.init();
    const r = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH });
    expect(r.status).toBe(200);
    expect(logs.some((l) => l.msg === 'map_cache_unavailable')).toBe(true);
  });

  it('answers 422 MAP_NO_ROADS when the area has no matching streets', async () => {
    const { c } = setup({ byHost: { 'overpass-a.test': () => json({ version: 0.6, elements: [] }) } });
    await c.init();
    const r = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('MAP_NO_ROADS');
  });

  it('runs at most two upstream acquisitions at once and shares identical requests', async () => {
    let active = 0;
    let peak = 0;
    const { c, calls } = setup({
      config: { overpassEndpoints: [A] },
      byHost: {
        'overpass-a.test': async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 30));
          active--;
          return json(FIXTURE);
        },
      },
    });
    await c.init();
    const boxes: Array<[number, number, number, number]> = [BBOX_CH, [47.37, 8.54, 47.373, 8.545], [47.37, 8.54, 47.372, 8.545], BBOX_CH];
    const results = await Promise.all(boxes.map((bbox) => c.req('POST', '/maps/acquire', { bbox })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(peak).toBe(2);
    expect(calls).toHaveLength(3);
  });

  it('can be disabled', async () => {
    const { c, calls } = setup({ config: { mapAcquisition: false }, byHost: { 'overpass-a.test': () => json(FIXTURE) } });
    await c.init();
    const r = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('MAPS_DISABLED');
    const g = await c.req('GET', '/maps/geocode?q=Zurich');
    expect(g.status).toBe(503);
    expect((await c.req('GET', '/maps/status')).json.data.enabled).toBe(false);
    expect(loadConfig({ SWEEP_MAP_ACQUISITION: 'off' }).mapAcquisition).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('enforces CSRF on acquisitions', async () => {
    const { c, calls } = setup({ byHost: { 'overpass-a.test': () => json(FIXTURE) } });
    const none = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH });
    expect(none.status).toBe(403);
    expect(none.json.error.code).toBe('CSRF_TOKEN');
    await c.init();
    const forged = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH }, { 'x-csrf-token': 'forged' });
    expect(forged.status).toBe(403);
    const cross = await c.req('POST', '/maps/acquire', { bbox: BBOX_CH }, { origin: 'https://evil.example' });
    expect(cross.json.error.code).toBe('CSRF_ORIGIN');
    expect(calls).toHaveLength(0);
  });
});

describe('place search', () => {
  // Shape of a Nominatim jsonv2 search result (values are a test fixture).
  const NOMINATIM = [
    { place_id: 1, lat: '47.3717', lon: '8.5423', display_name: 'Test Place, Testland', category: 'place', type: 'quarter', boundingbox: ['47.3650', '47.3780', '8.5350', '8.5500'] },
    { place_id: 2, lat: 'bad', lon: '8.5', display_name: 'Broken', boundingbox: ['1', '2', '3', '4'] },
  ];

  it('geocodes through Nominatim with a User-Agent, maps the bbox and caches results', async () => {
    const { c, calls } = setup({ config: { nominatimEndpoint: 'https://nominatim.test/search' }, byHost: { 'nominatim.test': () => json(NOMINATIM) } });
    const r = await c.req('GET', '/maps/geocode?q=Test%20Place');
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual([{ name: 'Test Place, Testland', lat: 47.3717, lon: 8.5423, bbox: [47.365, 8.535, 47.378, 8.55], type: 'place:quarter' }]);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('q')).toBe('Test Place');
    expect((calls[0]!.init!.headers as Record<string, string>)['User-Agent']).toBe(SWEEP_USER_AGENT);
    const again = await c.req('GET', '/maps/geocode?q=test%20place');
    expect(again.json.data).toEqual(r.json.data);
    expect(calls).toHaveLength(1);
  });

  it('validates the query', async () => {
    const { c, calls } = setup({ config: { nominatimEndpoint: 'https://nominatim.test/search' }, byHost: { 'nominatim.test': () => json(NOMINATIM) } });
    expect((await c.req('GET', '/maps/geocode?q=a')).json.error.code).toBe('INVALID_QUERY');
    expect((await c.req('GET', '/maps/geocode')).status).toBe(400);
    expect((await c.req('GET', `/maps/geocode?q=${'x'.repeat(121)}`)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('throttles upstream searches to one per second', async () => {
    const { c, calls } = setup({ config: { nominatimEndpoint: 'https://nominatim.test/search' }, byHost: { 'nominatim.test': () => json(NOMINATIM) } });
    const t0 = Date.now();
    await c.req('GET', '/maps/geocode?q=first');
    await c.req('GET', '/maps/geocode?q=second');
    expect(calls).toHaveLength(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
  });

  it('reports geocoder failures with the classified cause', async () => {
    const { c } = setup({ config: { nominatimEndpoint: 'https://nominatim.test/search' } });
    const r = await c.req('GET', '/maps/geocode?q=Zurich');
    expect(r.status).toBe(502);
    expect(r.json.error.code).toBe('GEOCODER_UNAVAILABLE');
    expect(r.json.error.details.attempt.errorClass).toBe('dns');
  });
});

describe('error hygiene', () => {
  it('never echoes proxy credentials', () => {
    const env = { HTTPS_PROXY: 'http://agent:s3cr3t-token@proxy.internal:3128' };
    const out = redact('connect via http://agent:s3cr3t-token@proxy.internal:3128 failed; other https://u:p@host.test/x', env);
    expect(out).not.toContain('s3cr3t');
    expect(out).not.toContain('u:p@');
    const cls = classifyFetchError(Object.assign(new TypeError('fetch failed'), { cause: new Error('Proxy https://u:pw@proxy.test refused') }));
    expect(cls.errorClass).toBe('proxy-refused');
    expect(cls.error).not.toContain('u:pw');
  });
});
