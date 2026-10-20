import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z, type ZodType } from 'zod';
import {
  buildOverpassQuery,
  DRIVABLE_ROAD_CLASSES,
  KNOWN_ROAD_CLASSES,
  MAX_BBOX_KM2,
  normalizeRoadClasses,
  OSM_ATTRIBUTION,
  OSM_COPYRIGHT_URL,
  OSM_LICENSE,
  OsmImportError,
  osmToGraph,
  validateBbox,
  type BBox,
  type OsmImportResult,
} from './engine.js';
import type { ServerConfig } from './config.js';
import { ApiError, ok } from './http.js';
import { rateLimiter } from './security.js';

/**
 * Live map acquisition: OpenStreetMap streets from public Overpass API
 * instances, and place search through Nominatim.
 *
 * Provider etiquette (OSMF / Overpass / Nominatim usage policies):
 * - every request identifies SWEEP with a real User-Agent;
 * - requested areas are capped (MAX_BBOX_KM2) and queries ask only for ways
 *   of whitelisted highway classes;
 * - Overpass responses are cached on disk for 7 days (key = SHA-256 of the
 *   query), identical concurrent requests share one upstream call, and at most
 *   2 upstream acquisitions run at once;
 * - Nominatim is called at most once per second process-wide, results are
 *   cached in memory, and only on explicit searches (never autocomplete);
 * - every response carries "© OpenStreetMap contributors" (ODbL 1.0).
 * Errors are classified per provider from the real failure (DNS, TLS, proxy
 * refusal, timeout, rate limit, busy, invalid or oversized response) and
 * returned to the client; credentials in proxy URLs are never logged or echoed.
 */

export const SWEEP_USER_AGENT = 'SWEEP/1.0 (urban route-intelligence; https://github.com/trivediyash154-source/SWEEP)';

const OVERPASS_TIMEOUT_MS = 45_000;
/** Total time one acquisition may spend across all providers. */
const ACQUIRE_BUDGET_MS = 120_000;
const GEOCODE_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const MAX_GEOCODE_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const GEOCODE_CACHE_TTL_MS = 24 * 3600 * 1000;
const GEOCODE_CACHE_MAX = 500;
const GEOCODE_INTERVAL_MS = 1000;
const GEOCODE_MAX_WAITING = 5;
const MAX_CONCURRENT_UPSTREAM = 2;
const MAX_QUEUED_ACQUISITIONS = 8;

/** Regional Overpass instances: only queried when the whole bbox lies inside their coverage. */
const REGIONAL_COVERAGE: Record<string, { bbox: BBox; label: string }> = {
  'overpass.osm.ch': { bbox: [45.8, 5.9, 47.9, 10.6], label: 'Switzerland' },
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type ParseBody = <S extends ZodType>(c: Context, schema: S) => Promise<z.infer<S>>;

export interface MapRoutesDeps {
  config: ServerConfig;
  fetch: FetchLike;
  now: () => number;
  log: (msg: string, meta?: Record<string, unknown>) => void;
  clientIp: (c: Context) => string;
  parseBody: ParseBody;
}

export type AttemptErrorClass =
  | 'out-of-coverage'
  | 'budget-exhausted'
  | 'dns'
  | 'tls'
  | 'proxy-refused'
  | 'timeout'
  | 'rate-limited'
  | 'busy'
  | 'http-error'
  | 'invalid-json'
  | 'invalid-response'
  | 'provider-error'
  | 'too-large'
  | 'network';

export interface ProviderAttempt {
  endpoint: string;
  host: string;
  ok: boolean;
  status?: number;
  errorClass?: AttemptErrorClass;
  error?: string;
  skipped?: boolean;
  ms: number;
}

interface Fetched {
  endpoint: string;
  retrievedAt: string;
  data: unknown;
}

export const acquireSchema = z.object({
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  roadClasses: z.array(z.string().max(40)).min(1).max(KNOWN_ROAD_CLASSES.length * 2).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  keepAllComponents: z.boolean().optional(),
});

// ---------------------------------------------------------------- helpers

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint.slice(0, 80);
  }
}

/** Remove credentials and proxy URLs from any text that may reach logs or clients. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = env[name];
    if (v && v.length > 4) out = out.split(v).join('[proxy]');
  }
  return out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@').slice(0, 300);
}

class ResponseTooLargeError extends Error {}

/** Read a response body as text, refusing more than `cap` bytes. */
async function readCapped(res: Response, cap: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(`The response is ${Math.round(declared / 1048576)} MB; the limit is ${Math.round(cap / 1048576)} MB.`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(`The response exceeds the ${Math.round(cap / 1048576)} MB limit.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A short, tag-free hint from an error page: Overpass "Error: …" text or the HTML title. Reads at most `cap` bytes. */
async function errorSnippet(res: Response, cap = 4096): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return '';
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const text = Buffer.concat(chunks).toString('utf8').slice(0, cap);
  const overpass = /Error<\/strong>:\s*([^<]{1,300})/i.exec(text)?.[1];
  const title = /<title>([^<]{1,200})<\/title>/i.exec(text)?.[1];
  const hint = (overpass ?? title ?? '').replace(/\s+/g, ' ').trim();
  return hint ? redact(hint).slice(0, 160) : '';
}

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  cause?: unknown;
}

/** Classify a thrown fetch error from its real cause chain. */
export function classifyFetchError(err: unknown): { errorClass: AttemptErrorClass; error: string } {
  const chain: ErrorLike[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
    chain.push(cur as ErrorLike);
    cur = (cur as ErrorLike).cause;
  }
  const str = (x: unknown): string => (typeof x === 'string' ? x : '');
  const codes = chain.map((c) => str(c.code)).filter(Boolean);
  const names = chain.map((c) => str(c.name));
  const detail = redact(chain.map((c) => [str(c.code), str(c.message)].filter(Boolean).join(' ')).filter(Boolean).join(' ← '));
  const text = `${codes.join(' ')} ${detail}`;
  if (err instanceof ResponseTooLargeError) return { errorClass: 'too-large', error: err.message };
  if (names.includes('TimeoutError') || names.includes('AbortError') || codes.some((c) => /^(UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT|ETIMEDOUT)$/.test(c))) {
    return { errorClass: 'timeout', error: `Timed out (${detail || 'no response'}).` };
  }
  if (codes.some((c) => c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'EAI_NONAME' || c === 'EAI_FAIL') || /getaddrinfo/i.test(text)) {
    return { errorClass: 'dns', error: `DNS lookup failed: the host name could not be resolved (${detail}).` };
  }
  if (codes.some((c) => /^(CERT_|ERR_TLS|ERR_SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|DEPTH_ZERO)/.test(c)) || /certificate|self[- ]signed|unable to verify/i.test(text)) {
    return { errorClass: 'tls', error: `TLS/certificate verification failed (${detail}).` };
  }
  if (/proxy|tunnel/i.test(text)) return { errorClass: 'proxy-refused', error: `The network proxy refused the connection (${detail}).` };
  if (codes.some((c) => c === 'ECONNREFUSED' || c === 'ECONNRESET' || c === 'EPIPE' || c === 'UND_ERR_SOCKET' || c === 'EHOSTUNREACH' || c === 'ENETUNREACH')) {
    return { errorClass: 'proxy-refused', error: `Connection refused or reset; a proxy or firewall may be blocking this host (${detail}).` };
  }
  return { errorClass: 'network', error: `Network error (${detail || 'unknown'}).` };
}

/** Classify a non-2xx HTTP status. */
export function classifyStatus(status: number): { errorClass: AttemptErrorClass; error: string } {
  if (status === 429) return { errorClass: 'rate-limited', error: 'HTTP 429: the provider is rate-limiting requests from this server; try again in a minute.' };
  if (status === 407) return { errorClass: 'proxy-refused', error: 'HTTP 407: the network proxy requires authentication for this host.' };
  if (status === 403) return { errorClass: 'proxy-refused', error: 'HTTP 403: access refused (by the provider or by a network proxy).' };
  if (status >= 500) return { errorClass: 'busy', error: `HTTP ${status}: the provider is busy, overloaded or timed out.` };
  return { errorClass: 'http-error', error: `HTTP ${status}: the provider rejected the request.` };
}

/** Problems with a parsed Overpass response, or null when it is usable. */
function overpassProblem(data: unknown): { errorClass: AttemptErrorClass; error: string } | null {
  if (!data || typeof data !== 'object' || !Array.isArray((data as { elements?: unknown }).elements)) {
    return { errorClass: 'invalid-response', error: 'The response is JSON but not Overpass API output (no "elements" array).' };
  }
  const remark = (data as { remark?: unknown }).remark;
  if (typeof remark === 'string' && /runtime (error|remark)|timed out|out of memory/i.test(remark)) {
    return { errorClass: 'provider-error', error: `Overpass reported: ${redact(remark).slice(0, 200)}` };
  }
  return null;
}

/** Fixed-size slot pool; a released slot passes straight to the next waiter. */
class Slots {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(
    private readonly max: number,
    private readonly maxWaiting: number,
  ) {}
  async acquire(): Promise<() => void> {
    if (this.active < this.max) this.active++;
    else {
      if (this.waiting.length >= this.maxWaiting) throw new ApiError(503, 'MAPS_BUSY', 'The map service is busy with other downloads. Please try again in a minute.');
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

interface CacheEntry {
  format: 'sweep.map-cache';
  version: 1;
  query: string;
  endpoint: string;
  retrievedAt: string;
  data: unknown;
}

function createDiskCache(dir: string, now: () => number, log: MapRoutesDeps['log']) {
  let warned = false;
  const warn = (op: string, err: unknown): void => {
    if (warned) return;
    warned = true;
    log('map_cache_unavailable', { op, error: (err as { code?: string }).code ?? 'unknown', note: 'Map acquisition continues without caching.' });
  };
  const file = (key: string): string => join(dir, `${key}.json`);
  return {
    async read(key: string, query: string): Promise<Fetched | null> {
      let text: string;
      try {
        text = await readFile(file(key), 'utf8');
      } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') warn('read', err);
        return null;
      }
      try {
        const e = JSON.parse(text) as Partial<CacheEntry>;
        if (e.format !== 'sweep.map-cache' || e.query !== query || typeof e.endpoint !== 'string' || typeof e.retrievedAt !== 'string') return null;
        const age = now() - Date.parse(e.retrievedAt);
        if (!(age >= -60_000 && age < CACHE_TTL_MS)) return null;
        if (overpassProblem(e.data)) return null;
        return { endpoint: e.endpoint, retrievedAt: e.retrievedAt, data: e.data };
      } catch {
        return null;
      }
    },
    async write(key: string, query: string, f: Fetched): Promise<void> {
      const entry: CacheEntry = { format: 'sweep.map-cache', version: 1, query, endpoint: f.endpoint, retrievedAt: f.retrievedAt, data: f.data };
      const tmp = join(dir, `${key}.${randomBytes(6).toString('hex')}.tmp`);
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(tmp, JSON.stringify(entry));
        await rename(tmp, file(key));
      } catch (err) {
        warn('write', err);
        await rm(tmp, { force: true }).catch(() => undefined);
      }
    },
  };
}

const bboxInside = (inner: BBox, outer: BBox): boolean => inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];

// ---------------------------------------------------------------- routes

export function mapRoutes(deps: MapRoutesDeps): Hono {
  const { config, now, log } = deps;
  const app = new Hono();
  const cache = createDiskCache(config.mapCacheDir, now, log);
  const slots = new Slots(MAX_CONCURRENT_UPSTREAM, MAX_QUEUED_ACQUISITIONS);
  const inflight = new Map<string, Promise<{ fetched: Fetched | null; attempts: ProviderAttempt[] }>>();
  const geoCache = new Map<string, { at: number; results: GeocodeResult[] }>();
  let geocodeNextAt = 0;
  let geocodeWaiting = 0;

  const enabled: MiddlewareHandler = async (_c, next) => {
    if (!config.mapAcquisition) throw new ApiError(503, 'MAPS_DISABLED', 'Live map acquisition is disabled on this server. Import a GeoJSON file or load the bundled Zurich Altstadt sample instead.');
    return next();
  };
  const acquireLimiter = rateLimiter({ key: 'maps-acquire', windowMs: 60_000, max: 6, enabled: config.rateLimit, clientIp: deps.clientIp });
  const geocodeLimiter = rateLimiter({ key: 'maps-geocode', windowMs: 60_000, max: 30, enabled: config.rateLimit, clientIp: deps.clientIp });

  app.get('/status', (c) =>
    ok(c, {
      enabled: config.mapAcquisition,
      endpoints: config.overpassEndpoints,
      geocoder: hostOf(config.nominatimEndpoint),
      maxAreaKm2: MAX_BBOX_KM2,
      roadClasses: { default: DRIVABLE_ROAD_CLASSES, allowed: KNOWN_ROAD_CLASSES },
      cache: { ttlHours: CACHE_TTL_MS / 3600_000, ...(isAbsolute(config.mapCacheDir) ? {} : { dir: config.mapCacheDir }) },
      attribution: OSM_ATTRIBUTION,
      license: OSM_LICENSE,
      licenseUrl: OSM_COPYRIGHT_URL,
    }),
  );

  /** Try each provider in order until one returns usable Overpass JSON. */
  const fetchFromProviders = async (query: string, bbox: BBox): Promise<{ fetched: Fetched | null; attempts: ProviderAttempt[] }> => {
    const attempts: ProviderAttempt[] = [];
    const deadline = Date.now() + ACQUIRE_BUDGET_MS;
    for (const endpoint of config.overpassEndpoints) {
      const host = hostOf(endpoint);
      const coverage = REGIONAL_COVERAGE[host];
      if (coverage && !bboxInside(bbox, coverage.bbox)) {
        attempts.push({ endpoint, host, ok: false, skipped: true, errorClass: 'out-of-coverage', error: `Skipped: ${host} only covers ${coverage.label}.`, ms: 0 });
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining < 5000) {
        attempts.push({ endpoint, host, ok: false, skipped: true, errorClass: 'budget-exhausted', error: 'Skipped: the time budget for this download was used up by earlier providers.', ms: 0 });
        continue;
      }
      const t0 = performance.now();
      const ms = (): number => Math.round(performance.now() - t0);
      try {
        const res = await deps.fetch(endpoint, {
          method: 'POST',
          headers: { 'User-Agent': SWEEP_USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: new URLSearchParams({ data: query }).toString(),
          signal: AbortSignal.timeout(Math.min(OVERPASS_TIMEOUT_MS, remaining)),
        });
        if (!res.ok) {
          const hint = await errorSnippet(res);
          const cls = classifyStatus(res.status);
          attempts.push({ endpoint, host, ok: false, status: res.status, ms: ms(), errorClass: cls.errorClass, error: hint ? `${cls.error} Provider said: "${hint}".` : cls.error });
          continue;
        }
        const text = await readCapped(res, MAX_RESPONSE_BYTES);
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          const type = res.headers.get('content-type')?.split(';')[0] ?? 'unknown type';
          attempts.push({ endpoint, host, ok: false, status: res.status, ms: ms(), errorClass: 'invalid-json', error: `The response is not valid JSON (${type}, ${text.length} bytes).` });
          continue;
        }
        const problem = overpassProblem(data);
        if (problem) {
          attempts.push({ endpoint, host, ok: false, status: res.status, ms: ms(), ...problem });
          continue;
        }
        attempts.push({ endpoint, host, ok: true, status: res.status, ms: ms() });
        return { fetched: { endpoint, retrievedAt: new Date(now()).toISOString(), data }, attempts };
      } catch (err) {
        attempts.push({ endpoint, host, ok: false, ms: ms(), ...classifyFetchError(err) });
      }
    }
    return { fetched: null, attempts };
  };

  app.post('/acquire', enabled, acquireLimiter, async (c) => {
    const body = await deps.parseBody(c, acquireSchema);
    const bbox = body.bbox as BBox;
    const problems = validateBbox(bbox, MAX_BBOX_KM2);
    if (problems.length) throw new ApiError(400, 'INVALID_BBOX', problems.join(' '), { problems });
    let classes: string[];
    try {
      classes = normalizeRoadClasses(body.roadClasses ?? DRIVABLE_ROAD_CLASSES);
    } catch (err) {
      if (err instanceof OsmImportError) throw new ApiError(400, 'INVALID_ROAD_CLASS', err.message);
      throw err;
    }
    const query = buildOverpassQuery(bbox, classes);
    const key = createHash('sha256').update(query).digest('hex');

    let fetched = await cache.read(key, query);
    const cached = fetched !== null;
    let attempts: ProviderAttempt[] = [];
    if (!fetched) {
      let pending = inflight.get(key);
      if (!pending) {
        pending = (async () => {
          const release = await slots.acquire();
          try {
            const r = await fetchFromProviders(query, bbox);
            if (r.fetched) await cache.write(key, query, r.fetched);
            return r;
          } finally {
            release();
          }
        })();
        inflight.set(key, pending);
        void pending.finally(() => inflight.delete(key)).catch(() => undefined);
      }
      const r = await pending;
      attempts = r.attempts;
      fetched = r.fetched;
      if (!fetched) {
        const tried = attempts.filter((a) => !a.skipped);
        const summary = tried.map((a) => `${a.host}: ${a.errorClass}`).join('; ');
        log('map_acquire_failed', { attempts: attempts.map((a) => `${a.host}:${a.errorClass}`) });
        throw new ApiError(
          502,
          'MAP_PROVIDERS_UNAVAILABLE',
          `No map provider could deliver data (${tried.length} tried${summary ? `: ${summary}` : ''}). Import a GeoJSON file of the area, or load the bundled Zurich Altstadt sample, instead.`,
          { attempts },
        );
      }
    }

    const host = hostOf(fetched.endpoint);
    let result: OsmImportResult;
    try {
      result = osmToGraph(fetched.data, {
        name: body.name ?? `OpenStreetMap streets (${bbox[0].toFixed(4)}, ${bbox[1].toFixed(4)} – ${bbox[2].toFixed(4)}, ${bbox[3].toFixed(4)})`,
        roadClasses: classes,
        keepAllComponents: body.keepAllComponents ?? false,
        source: {
          kind: 'live-acquisition',
          provider: `OpenStreetMap via Overpass API (${host})`,
          endpoint: fetched.endpoint,
          retrievedAt: fetched.retrievedAt,
          bbox,
          attribution: OSM_ATTRIBUTION,
          license: OSM_LICENSE,
          roadClasses: classes,
          cached,
        },
      });
    } catch (err) {
      if (err instanceof OsmImportError && err.code === 'NO_ROADS') throw new ApiError(422, 'MAP_NO_ROADS', `${err.message} Try a larger area or more road classes.`, { attempts, cached });
      if (err instanceof OsmImportError && err.code === 'LIMIT_EXCEEDED') throw new ApiError(422, 'MAP_TOO_LARGE', err.message, { attempts, cached });
      if (err instanceof OsmImportError) throw new ApiError(502, 'MAP_INVALID_DATA', err.message, { attempts, cached });
      throw err;
    }
    log('map_acquired', { host, cached, edges: result.stats.edges, vertices: result.stats.vertices, attempts: attempts.map((a) => `${a.host}:${a.ok ? 'ok' : a.errorClass}`) });
    return ok(c, { graph: result.graph, report: { stats: result.stats, notes: result.notes, roadClassesFound: result.roadClassesFound }, attempts, cached, query });
  });

  /** Wait for the process-wide Nominatim slot (1 request per second). */
  const geocodeTurn = async (): Promise<void> => {
    const t = Date.now();
    const wait = Math.max(0, geocodeNextAt - t);
    if (wait > 0 && geocodeWaiting >= GEOCODE_MAX_WAITING) {
      throw new ApiError(429, 'GEOCODE_BUSY', 'Place search is limited to one request per second; please try again shortly.');
    }
    geocodeNextAt = Math.max(t, geocodeNextAt) + GEOCODE_INTERVAL_MS;
    if (wait > 0) {
      geocodeWaiting++;
      try {
        await new Promise((resolve) => setTimeout(resolve, wait));
      } finally {
        geocodeWaiting--;
      }
    }
  };

  app.get('/geocode', enabled, geocodeLimiter, async (c) => {
    const q = (c.req.query('q') ?? '').trim().replace(/\s+/g, ' ');
    if (q.length < 2 || q.length > 120) throw new ApiError(400, 'INVALID_QUERY', 'Enter 2 to 120 characters to search for a place.');
    const cacheKey = q.toLowerCase();
    const hit = geoCache.get(cacheKey);
    if (hit && now() - hit.at < GEOCODE_CACHE_TTL_MS) return ok(c, hit.results);

    await geocodeTurn();
    const url = new URL(config.nominatimEndpoint);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '5');
    url.searchParams.set('q', q);
    const host = url.host;
    const t0 = performance.now();
    let raw: unknown;
    try {
      const res = await deps.fetch(url.toString(), {
        headers: { 'User-Agent': SWEEP_USER_AGENT, Accept: 'application/json', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(GEOCODE_TIMEOUT_MS),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        const cls = classifyStatus(res.status);
        throw new ApiError(502, 'GEOCODER_UNAVAILABLE', `Place search failed. ${cls.error}`, { attempt: { endpoint: url.origin + url.pathname, host, ok: false, status: res.status, ms: Math.round(performance.now() - t0), ...cls } });
      }
      raw = JSON.parse(await readCapped(res, MAX_GEOCODE_BYTES));
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const cls = err instanceof SyntaxError ? { errorClass: 'invalid-json' as const, error: 'The geocoder did not return JSON.' } : classifyFetchError(err);
      throw new ApiError(502, 'GEOCODER_UNAVAILABLE', `Place search failed. ${cls.error}`, { attempt: { endpoint: url.origin + url.pathname, host, ok: false, ms: Math.round(performance.now() - t0), ...cls } });
    }
    const results = parseNominatim(raw);
    if (geoCache.size >= GEOCODE_CACHE_MAX) geoCache.delete(geoCache.keys().next().value!);
    geoCache.set(cacheKey, { at: now(), results });
    return ok(c, results);
  });

  return app;
}

export interface GeocodeResult {
  name: string;
  lat: number;
  lon: number;
  /** [south, west, north, east] */
  bbox: BBox;
  type?: string;
}

function parseNominatim(raw: unknown): GeocodeResult[] {
  if (!Array.isArray(raw)) return [];
  const out: GeocodeResult[] = [];
  for (const item of raw.slice(0, 5)) {
    const it = item as { display_name?: unknown; name?: unknown; lat?: unknown; lon?: unknown; boundingbox?: unknown; category?: unknown; type?: unknown };
    const lat = Number(it.lat);
    const lon = Number(it.lon);
    const bb = Array.isArray(it.boundingbox) ? it.boundingbox.map(Number) : [];
    const name = String(it.display_name ?? it.name ?? '').slice(0, 200);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lon) || bb.length !== 4 || !bb.every(Number.isFinite)) continue;
    // Nominatim boundingbox = [minLat, maxLat, minLon, maxLon]
    out.push({ name, lat, lon, bbox: [bb[0]!, bb[2]!, bb[1]!, bb[3]!], ...(typeof it.category === 'string' && typeof it.type === 'string' ? { type: `${it.category}:${it.type}` } : {}) });
  }
  return out;
}
