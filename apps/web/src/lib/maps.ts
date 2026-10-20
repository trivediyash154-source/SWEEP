/**
 * Live map acquisition client.
 *
 * With a SWEEP server, requests go through /api/maps/* (server-side caching,
 * provider fallback, throttling, error classification). Static builds (or when
 * no server answers) fall back to a direct browser request to the public
 * Overpass API at overpass-api.de and convert locally with osmToGraph.
 * Map data: © OpenStreetMap contributors, ODbL 1.0.
 */
import {
  bboxAreaKm2,
  bboxSizeMetres,
  buildOverpassQuery,
  mergeElements,
  DRIVABLE_ROAD_CLASSES,
  MAX_BBOX_KM2,
  MIN_BBOX_KM2,
  normalizeRoadClasses,
  OSM_ATTRIBUTION,
  OSM_LICENSE,
  OsmImportError,
  osmToGraph,
  validateBbox,
  type BBox,
  type Graph,
  type OsmElement,
  type OsmImportStats,
} from '@sweep/engine';
import { api, ApiRequestError, isStaticBuild, serverAvailable } from './api';

export interface MapAttempt {
  endpoint: string;
  host: string;
  ok: boolean;
  status?: number;
  errorClass?: string;
  error?: string;
  skipped?: boolean;
  ms: number;
}

export interface MapAcquireRequest {
  bbox: BBox;
  roadClasses?: string[];
  name?: string;
  keepAllComponents?: boolean;
}

export interface MapAcquisition {
  graph: Graph;
  report: { stats: OsmImportStats; notes: string[]; roadClassesFound: Record<string, number> };
  attempts: MapAttempt[];
  cached: boolean;
  query: string;
  /** Who contacted the provider: the SWEEP server, or this browser directly (static build). */
  via: 'server' | 'browser';
}

export interface PlaceResult {
  name: string;
  lat: number;
  lon: number;
  /** [south, west, north, east] */
  bbox: BBox;
  type?: string;
}

export interface MapStatus {
  enabled: boolean;
  endpoints: string[];
  geocoder: string;
  maxAreaKm2: number;
}

export class MapAcquireError extends Error {
  constructor(
    message: string,
    public code: string,
    public attempts: MapAttempt[] = [],
    public status = 0,
  ) {
    super(message);
    this.name = 'MapAcquireError';
  }
}

export type AcquireStage = 'contacting' | 'converting';

/** Real places, coordinates only: the streets are always downloaded live. */
export const MAP_PRESETS: { id: string; label: string; bbox: BBox }[] = [
  { id: 'zurich-altstadt', label: 'Zurich — Altstadt / Niederdorf', bbox: [47.37, 8.54, 47.3735, 8.5455] },
  { id: 'bern-altstadt', label: 'Bern — Altstadt around the Zytglogge', bbox: [46.9465, 7.444, 46.95, 7.454] },
  { id: 'pune-deccan', label: 'Pune — Deccan Gymkhana', bbox: [18.516, 73.84, 18.519, 73.844] },
];

export const BROWSER_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const BROWSER_NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const BROWSER_TIMEOUT_MS = 45_000;
const MAX_RESPONSE_BYTES = 25 * 1024 * 1024;

async function hasServer(): Promise<boolean> {
  if (isStaticBuild) return false;
  return serverAvailable();
}

const isAbort = (err: unknown): boolean => (err as { name?: string })?.name === 'AbortError';

function toMapError(err: unknown): unknown {
  if (err instanceof ApiRequestError) {
    const details = err.details as { attempts?: MapAttempt[]; attempt?: MapAttempt } | undefined;
    return new MapAcquireError(err.message, err.code, details?.attempts ?? (details?.attempt ? [details.attempt] : []), err.status);
  }
  return err;
}

/** Server status, or null when there is no server (static build). */
export async function fetchMapStatus(signal?: AbortSignal): Promise<MapStatus | null> {
  if (!(await hasServer())) return null;
  try {
    return await api<MapStatus>('/maps/status', signal ? { signal } : {});
  } catch {
    return null;
  }
}

/** Download the streets inside a bbox and convert them into a SWEEP graph. */
export async function acquireMap(req: MapAcquireRequest, opts: { signal?: AbortSignal; onStage?: (stage: AcquireStage) => void } = {}): Promise<MapAcquisition> {
  const problems = validateBbox(req.bbox, MAX_BBOX_KM2);
  if (problems.length) throw new MapAcquireError(problems.join(' '), 'INVALID_BBOX');
  opts.onStage?.('contacting');
  if (await hasServer()) {
    try {
      const data = await api<Omit<MapAcquisition, 'via'>>('/maps/acquire', { method: 'POST', body: req, ...(opts.signal ? { signal: opts.signal } : {}) });
      return { ...data, via: 'server' };
    } catch (err) {
      throw toMapError(err);
    }
  }
  return acquireInBrowser(req, opts);
}

const browserCache = new Map<string, { endpoint: string; retrievedAt: string; data: unknown }>();

async function acquireInBrowser(req: MapAcquireRequest, opts: { signal?: AbortSignal; onStage?: (stage: AcquireStage) => void }): Promise<MapAcquisition> {
  let classes: string[];
  try {
    classes = normalizeRoadClasses(req.roadClasses ?? DRIVABLE_ROAD_CLASSES);
  } catch (err) {
    throw new MapAcquireError((err as Error).message, 'INVALID_ROAD_CLASS');
  }
  const query = buildOverpassQuery(req.bbox, classes);
  const endpoint = BROWSER_OVERPASS_ENDPOINT;
  const host = new URL(endpoint).host;
  const attempts: MapAttempt[] = [];
  let fetched = browserCache.get(query);
  const cached = fetched !== undefined;
  if (!fetched) {
    const t0 = performance.now();
    const ms = (): number => Math.round(performance.now() - t0);
    const timeout = AbortSignal.timeout(BROWSER_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const fail = (a: Omit<MapAttempt, 'endpoint' | 'host' | 'ok' | 'ms'>): never => {
      attempts.push({ endpoint, host, ok: false, ms: ms(), ...a });
      throw new MapAcquireError(`${host} could not deliver data: ${a.error ?? a.errorClass}. Import a GeoJSON file of the area, or load the bundled Zurich Altstadt sample, instead.`, 'MAP_PROVIDERS_UNAVAILABLE', attempts);
    };
    let res: Response | null = null;
    try {
      res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json' }, body: new URLSearchParams({ data: query }), signal });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (timeout.aborted) fail({ errorClass: 'timeout', error: `no answer within ${BROWSER_TIMEOUT_MS / 1000} s` });
      fail({ errorClass: 'network', error: `the browser could not reach it (offline, blocked by an extension or network policy, or a CORS failure: ${(err as Error).message})` });
    }
    if (!res!.ok) {
      const status = res!.status;
      fail({ status, errorClass: status === 429 ? 'rate-limited' : status >= 500 ? 'busy' : 'http-error', error: status === 429 ? 'HTTP 429, rate-limited; wait a minute' : status >= 500 ? `HTTP ${status}, the provider is busy` : `HTTP ${status}` });
    }
    const declared = Number(res!.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) fail({ status: res!.status, errorClass: 'too-large', error: 'the response is larger than 25 MB' });
    let text = '';
    try {
      text = await res!.text();
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      fail({ status: res!.status, errorClass: timeout.aborted ? 'timeout' : 'network', error: 'the download was interrupted' });
    }
    if (text.length > MAX_RESPONSE_BYTES) fail({ status: res!.status, errorClass: 'too-large', error: 'the response is larger than 25 MB' });
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      fail({ status: res!.status, errorClass: 'invalid-json', error: 'the response is not JSON' });
    }
    const remark = (data as { remark?: unknown })?.remark;
    if (!Array.isArray((data as { elements?: unknown })?.elements)) fail({ status: res!.status, errorClass: 'invalid-response', error: 'the response is not Overpass API output' });
    if (typeof remark === 'string' && /runtime (error|remark)|timed out|out of memory/i.test(remark)) fail({ status: res!.status, errorClass: 'provider-error', error: remark.slice(0, 200) });
    attempts.push({ endpoint, host, ok: true, status: res!.status, ms: ms() });
    fetched = { endpoint, retrievedAt: new Date().toISOString(), data };
    if (browserCache.size >= 10) browserCache.delete(browserCache.keys().next().value!);
    browserCache.set(query, fetched);
  }
  opts.onStage?.('converting');
  const [s, w, n, e] = req.bbox;
  try {
    const r = osmToGraph(fetched.data, {
      name: req.name ?? `OpenStreetMap streets (${s.toFixed(4)}, ${w.toFixed(4)} – ${n.toFixed(4)}, ${e.toFixed(4)})`,
      roadClasses: classes,
      keepAllComponents: req.keepAllComponents ?? false,
      source: {
        kind: 'live-acquisition',
        provider: `OpenStreetMap via Overpass API (${host})`,
        endpoint: fetched.endpoint,
        retrievedAt: fetched.retrievedAt,
        bbox: req.bbox,
        attribution: OSM_ATTRIBUTION,
        license: OSM_LICENSE,
        roadClasses: classes,
        cached,
        notes: ['Downloaded directly by this browser (no SWEEP server available).'],
      },
    });
    return { graph: r.graph, report: { stats: r.stats, notes: r.notes, roadClassesFound: r.roadClassesFound }, attempts, cached, query, via: 'browser' };
  } catch (err) {
    if (err instanceof OsmImportError) {
      const code = err.code === 'NO_ROADS' ? 'MAP_NO_ROADS' : err.code === 'LIMIT_EXCEEDED' ? 'MAP_TOO_LARGE' : 'MAP_INVALID_DATA';
      throw new MapAcquireError(code === 'MAP_NO_ROADS' ? `${err.message} Try a larger area or more road classes.` : err.message, code, attempts);
    }
    throw err;
  }
}

// ---- large areas: several polite tile downloads, merged ------------------------

/** Largest area the Sweep planner downloads, as tiles of at most TILE_KM2 each. */
export const MAX_TILED_KM2 = 25;
const TILE_KM2 = 3.5;
const TILE_PAUSE_MS = 1000;
export const BROWSER_OVERPASS_ENDPOINTS = [BROWSER_OVERPASS_ENDPOINT, 'https://overpass.private.coffee/api/interpreter'];

/** Split a bbox into a grid of tiles of at most `maxKm2` each (south, west, north, east). */
export function splitBBox(bbox: BBox, maxKm2 = TILE_KM2): BBox[] {
  const { width, height } = bboxSizeMetres(bbox);
  const side = Math.sqrt(maxKm2) * 1000;
  const cols = Math.max(1, Math.ceil(width / side));
  const rows = Math.max(1, Math.ceil(height / side));
  const [s, w, n, e] = bbox;
  const r = (x: number): number => Math.round(x * 1e6) / 1e6;
  const out: BBox[] = [];
  for (let i = 0; i < rows; i++)
    for (let j = 0; j < cols; j++) out.push([r(s + ((n - s) * i) / rows), r(w + ((e - w) * j) / cols), r(s + ((n - s) * (i + 1)) / rows), r(w + ((e - w) * (j + 1)) / cols)]);
  return out;
}

const rawCache = new Map<string, { endpoint: string; elements: OsmElement[] }>();

/** One Overpass query from the browser, trying each public endpoint in turn. */
async function overpassFromBrowser(query: string, attempts: MapAttempt[], signal?: AbortSignal): Promise<{ endpoint: string; elements: OsmElement[]; cached: boolean }> {
  const hit = rawCache.get(query);
  if (hit) return { ...hit, cached: true };
  for (const endpoint of BROWSER_OVERPASS_ENDPOINTS) {
    const host = new URL(endpoint).host;
    const t0 = performance.now();
    const ms = (): number => Math.round(performance.now() - t0);
    const timeout = AbortSignal.timeout(BROWSER_TIMEOUT_MS);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json' }, body: new URLSearchParams({ data: query }), signal: sig });
      if (!res.ok) {
        attempts.push({ endpoint, host, ok: false, status: res.status, errorClass: res.status === 429 ? 'rate-limited' : res.status >= 500 ? 'busy' : 'http-error', error: `HTTP ${res.status}`, ms: ms() });
        continue;
      }
      const text = await res.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        attempts.push({ endpoint, host, ok: false, status: res.status, errorClass: 'too-large', error: 'the response is larger than 25 MB', ms: ms() });
        continue;
      }
      const data = JSON.parse(text) as { elements?: unknown; remark?: unknown };
      if (!Array.isArray(data.elements) || (typeof data.remark === 'string' && /runtime (error|remark)|timed out|out of memory/i.test(data.remark))) {
        attempts.push({ endpoint, host, ok: false, status: res.status, errorClass: 'provider-error', error: typeof data.remark === 'string' ? data.remark.slice(0, 200) : 'the response is not Overpass API output', ms: ms() });
        continue;
      }
      attempts.push({ endpoint, host, ok: true, status: res.status, ms: ms() });
      const out = { endpoint, elements: data.elements as OsmElement[] };
      if (rawCache.size >= 40) rawCache.delete(rawCache.keys().next().value!);
      rawCache.set(query, out);
      return { ...out, cached: false };
    } catch (err) {
      if (signal?.aborted) throw err;
      attempts.push({ endpoint, host, ok: false, errorClass: timeout.aborted ? 'timeout' : 'network', error: timeout.aborted ? `no answer within ${BROWSER_TIMEOUT_MS / 1000} s` : 'not reachable from this browser', ms: ms() });
    }
  }
  const last = attempts.slice(-BROWSER_OVERPASS_ENDPOINTS.length);
  throw new MapAcquireError(`No OpenStreetMap server delivered the streets: ${last.map((a) => `${a.host}: ${a.error ?? a.errorClass}`).join('; ')}. Try again in a minute, or draw a smaller zone.`, 'MAP_PROVIDERS_UNAVAILABLE', attempts);
}

/**
 * Streets of an area up to MAX_TILED_KM2: tiles of at most 3.5 km² are
 * downloaded one after another (with a pause, as the Overpass usage policy
 * asks), merged by OSM id, and converted once with osmToGraph.
 */
export async function acquireLargeArea(req: MapAcquireRequest, opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<MapAcquisition> {
  const problems = validateBbox(req.bbox, MAX_TILED_KM2);
  if (problems.length) throw new MapAcquireError(problems.join(' '), 'INVALID_BBOX');
  const classes = normalizeRoadClasses(req.roadClasses ?? DRIVABLE_ROAD_CLASSES);
  const tiles = splitBBox(req.bbox);
  const attempts: MapAttempt[] = [];
  const lists: OsmElement[][] = [];
  const endpoints = new Set<string>();
  let allCached = true;
  for (let i = 0; i < tiles.length; i++) {
    opts.onProgress?.(i, tiles.length);
    const r = await overpassFromBrowser(buildOverpassQuery(tiles[i]!, classes, 60), attempts, opts.signal);
    lists.push(r.elements);
    endpoints.add(r.endpoint);
    if (!r.cached) {
      allCached = false;
      if (i + 1 < tiles.length) await new Promise((res) => setTimeout(res, TILE_PAUSE_MS));
    }
  }
  opts.onProgress?.(tiles.length, tiles.length);
  const merged = mergeElements(lists);
  const [s, w, n, e] = req.bbox;
  try {
    const r = osmToGraph({ elements: merged.elements }, {
      name: req.name ?? `OpenStreetMap streets (${s.toFixed(4)}, ${w.toFixed(4)} – ${n.toFixed(4)}, ${e.toFixed(4)})`,
      roadClasses: classes,
      keepAllComponents: req.keepAllComponents ?? false,
      source: {
        kind: 'live-acquisition',
        provider: `OpenStreetMap via Overpass API (${[...endpoints].map((x) => new URL(x).host).join(', ')})`,
        endpoint: [...endpoints][0]!,
        retrievedAt: new Date().toISOString(),
        bbox: req.bbox,
        attribution: OSM_ATTRIBUTION,
        license: OSM_LICENSE,
        roadClasses: classes,
        cached: allCached,
        notes: [`Downloaded directly by this browser as ${tiles.length} tile(s) of at most ${TILE_KM2} km²; ${merged.duplicates} element(s) returned by more than one tile were merged.`],
      },
    });
    return { graph: r.graph, report: { stats: r.stats, notes: r.notes, roadClassesFound: r.roadClassesFound }, attempts, cached: allCached, query: buildOverpassQuery(tiles[0]!, classes, 60), via: 'browser' };
  } catch (err) {
    if (err instanceof OsmImportError) throw new MapAcquireError(err.code === 'NO_ROADS' ? `${err.message} Draw the zone over streets.` : err.message, err.code === 'NO_ROADS' ? 'MAP_NO_ROADS' : err.code === 'LIMIT_EXCEEDED' ? 'MAP_TOO_LARGE' : 'MAP_INVALID_DATA', attempts);
    throw err;
  }
}

// ---- place search (Nominatim: explicit searches only, never autocomplete) ----

const placeCache = new Map<string, PlaceResult[]>();
let browserGeocodeNextAt = 0;

export async function searchPlaces(q: string, signal?: AbortSignal): Promise<PlaceResult[]> {
  const query = q.trim().replace(/\s+/g, ' ');
  if (query.length < 2 || query.length > 120) throw new MapAcquireError('Enter 2 to 120 characters to search for a place.', 'INVALID_QUERY');
  const key = query.toLowerCase();
  const hit = placeCache.get(key);
  if (hit) return hit;
  let results: PlaceResult[];
  if (await hasServer()) {
    try {
      results = await api<PlaceResult[]>(`/maps/geocode?q=${encodeURIComponent(query)}`, signal ? { signal } : {});
    } catch (err) {
      throw toMapError(err);
    }
  } else {
    // Nominatim usage policy: at most one request per second.
    const wait = browserGeocodeNextAt - Date.now();
    browserGeocodeNextAt = Math.max(Date.now(), browserGeocodeNextAt) + 1000;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const url = new URL(BROWSER_NOMINATIM_ENDPOINT);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '5');
    url.searchParams.set('q', query);
    let raw: unknown;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) });
      if (!res.ok) throw new MapAcquireError(`Place search failed (HTTP ${res.status}).`, 'GEOCODER_UNAVAILABLE');
      raw = await res.json();
    } catch (err) {
      if (isAbort(err) || err instanceof MapAcquireError) throw err;
      throw new MapAcquireError('Place search is unavailable: the browser could not reach nominatim.openstreetmap.org.', 'GEOCODER_UNAVAILABLE');
    }
    results = (Array.isArray(raw) ? raw : []).flatMap((item: { display_name?: unknown; lat?: unknown; lon?: unknown; boundingbox?: unknown; category?: unknown; type?: unknown }) => {
      const lat = Number(item.lat);
      const lon = Number(item.lon);
      const bb = Array.isArray(item.boundingbox) ? item.boundingbox.map(Number) : [];
      if (typeof item.display_name !== 'string' || !Number.isFinite(lat) || !Number.isFinite(lon) || bb.length !== 4 || !bb.every(Number.isFinite)) return [];
      const r: PlaceResult = { name: item.display_name.slice(0, 200), lat, lon, bbox: [bb[0]!, bb[2]!, bb[1]!, bb[3]!] };
      if (typeof item.category === 'string' && typeof item.type === 'string') r.type = `${item.category}:${item.type}`;
      return [r];
    });
  }
  placeCache.set(key, results);
  return results;
}

// ---- bbox helpers for the dialog ----

/** A square bbox of `sideMetres` centred on a point. */
export function bboxAround(lat: number, lon: number, sideMetres = 800): BBox {
  const dLat = sideMetres / 2 / 111_195;
  const dLon = sideMetres / 2 / (111_195 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  const r = (x: number): number => Math.round(x * 1e5) / 1e5;
  return [r(Math.max(-90, lat - dLat)), r(Math.max(-180, lon - dLon)), r(Math.min(90, lat + dLat)), r(Math.min(180, lon + dLon))];
}

/** Use a search result's own extent when it fits the limits; otherwise a square around its centre. */
export function bboxForPlace(p: PlaceResult): { bbox: BBox; note?: string } {
  const area = bboxAreaKm2(p.bbox);
  if (area <= MAX_BBOX_KM2 && area >= MIN_BBOX_KM2) return { bbox: p.bbox };
  if (area < MIN_BBOX_KM2) return { bbox: bboxAround(p.lat, p.lon, 400), note: 'The place is a single point or very small; a 400 m square around it was selected.' };
  return { bbox: bboxAround(p.lat, p.lon, 800), note: `The place covers about ${area.toFixed(0)} km², above the ${MAX_BBOX_KM2} km² limit; an 800 m square around its centre was selected.` };
}
