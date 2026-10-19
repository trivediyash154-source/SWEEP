/**
 * Polite, resumable OpenStreetMap acquisition for one region (Overpass API).
 *
 *   pnpm city:acquire pune-bibwewadi            download missing tiles (resumes)
 *   pnpm city:acquire pune-bibwewadi --status   report what is cached
 *
 * The region config (data/regions/<id>.json) defines the bounding box, the tile
 * size and the endpoints. The area is split into tiles of `tileDeg` degrees;
 * every tile is queried twice (streets, building footprints), plus one query
 * for turn-restriction relations over the whole region. Responses are cached
 * in data/cache/osm/<id>/ with a manifest, so a rerun downloads only what is
 * missing. Usage-policy safeguards: one request at a time, at least
 * MIN_INTERVAL_MS between requests, a descriptive User-Agent, exponential
 * backoff on 429/5xx/timeouts, and moving to the next configured endpoint
 * after repeated failures.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const USER_AGENT = 'SWEEP/1.0 (urban route-intelligence; https://github.com/trivediyash154-source/SWEEP)';
const MIN_INTERVAL_MS = 4000;
const MAX_ATTEMPTS = 6;
const TIMEOUT_MS = 150_000;

export interface RegionConfig {
  id: string;
  name: string;
  description: string;
  bbox: [number, number, number, number];
  tileDeg: number;
  focus?: { lonlat: [number, number]; label: string; source?: string };
  roadClasses: string[];
  endpoints: string[];
}

export type TileKind = 'streets' | 'buildings' | 'restrictions';

export interface ManifestEntry {
  key: string;
  kind: TileKind;
  bbox: [number, number, number, number];
  status: 'ok' | 'failed';
  file: string;
  bytes?: number;
  osmBase?: string;
  endpoint?: string;
  fetchedAt?: string;
  attempts: number;
  lastError?: string;
}

export interface Manifest {
  region: string;
  bbox: [number, number, number, number];
  tileDeg: number;
  entries: Record<string, ManifestEntry>;
}

export const regionPath = (id: string): string => join(ROOT, 'data', 'regions', `${id}.json`);
export const cacheDir = (id: string): string => join(ROOT, 'data', 'cache', 'osm', id);

export function loadRegion(id: string): RegionConfig {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`Invalid region id "${id}".`);
  return JSON.parse(readFileSync(regionPath(id), 'utf8')) as RegionConfig;
}

/** Tiles from south to north, west to east. Keys match the original shell prototype (t<row>_<col>). */
export function tilesOf(r: RegionConfig): { key: string; bbox: [number, number, number, number] }[] {
  const [S, W, N, E] = r.bbox;
  const t = r.tileDeg;
  const out: { key: string; bbox: [number, number, number, number] }[] = [];
  const rows = Math.ceil((N - S) / t - 1e-9);
  const cols = Math.ceil((E - W) / t - 1e-9);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const s = S + i * t;
      const w = W + j * t;
      const r5 = (x: number): number => Math.round(x * 1e5) / 1e5;
      out.push({ key: `t${i}_${j}`, bbox: [r5(s), r5(w), r5(Math.min(N, s + t)), r5(Math.min(E, w + t))] });
    }
  }
  return out;
}

export function streetQuery(bbox: readonly number[], classes: readonly string[]): string {
  return `[out:json][timeout:90];way["highway"~"^(${classes.join('|')})$"](${bbox.map((x) => x.toFixed(5)).join(',')});(._;>;);out body;`;
}
export function buildingQuery(bbox: readonly number[]): string {
  return `[out:json][timeout:90];way["building"](${bbox.map((x) => x.toFixed(5)).join(',')});out geom tags;`;
}
export function restrictionQuery(bbox: readonly number[]): string {
  return `[out:json][timeout:90];rel["type"="restriction"](${bbox.map((x) => x.toFixed(5)).join(',')});out body;`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function loadManifest(r: RegionConfig): Manifest {
  const f = join(cacheDir(r.id), 'manifest.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as Manifest;
  return { region: r.id, bbox: r.bbox, tileDeg: r.tileDeg, entries: {} };
}
function saveManifest(r: RegionConfig, m: Manifest): void {
  const f = join(cacheDir(r.id), 'manifest.json');
  writeFileSync(`${f}.tmp`, JSON.stringify(m, null, 1));
  renameSync(`${f}.tmp`, f);
}

/** A response is usable when it is Overpass JSON with an elements array and no runtime-error remark. */
export function usableResponse(text: string): { ok: true; osmBase: string | undefined } | { ok: false; reason: string } {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  const o = j as { elements?: unknown; remark?: string; osm3s?: { timestamp_osm_base?: string } };
  if (!Array.isArray(o.elements)) return { ok: false, reason: 'no elements array' };
  if (typeof o.remark === 'string' && /runtime error|timed out|out of memory/i.test(o.remark)) return { ok: false, reason: `server remark: ${o.remark.slice(0, 120)}` };
  return { ok: true, osmBase: o.osm3s?.timestamp_osm_base };
}

/** Adopt a tile file that already exists in the cache (downloaded by an earlier run) into the manifest. */
function adoptExisting(r: RegionConfig, m: Manifest, key: string, kind: TileKind, bbox: [number, number, number, number]): boolean {
  const file = `${key}_${kind}.json`;
  const path = join(cacheDir(r.id), 'tiles', file);
  if (!existsSync(path)) return false;
  const text = readFileSync(path, 'utf8');
  const u = usableResponse(text);
  if (!u.ok) return false;
  m.entries[`${key}:${kind}`] = { key, kind, bbox, status: 'ok', file, bytes: Buffer.byteLength(text), ...(u.osmBase ? { osmBase: u.osmBase } : {}), attempts: m.entries[`${key}:${kind}`]?.attempts ?? 0, endpoint: m.entries[`${key}:${kind}`]?.endpoint ?? r.endpoints[0] };
  return true;
}

/** Endpoints that failed at the connection level twice in this run (unreachable from here); skipped until the next run. */
const connectionFailures = new Map<string, number>();
const liveEndpoints = (r: RegionConfig): string[] => {
  const live = r.endpoints.filter((e) => (connectionFailures.get(e) ?? 0) < 2);
  return live.length ? live : r.endpoints;
};

async function fetchOne(r: RegionConfig, query: string, log: (s: string) => void): Promise<{ text: string; endpoint: string; osmBase?: string } | { error: string; attempts: number }> {
  let lastError = '';
  let lastRequest = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const live = liveEndpoints(r);
    const endpoint = live[Math.floor((attempt - 1) / 2) % live.length]!;
    const wait = Math.max(0, lastRequest + MIN_INTERVAL_MS - Date.now());
    if (wait) await sleep(wait);
    lastRequest = Date.now();
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: 'application/json' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.ok) {
        const u = usableResponse(text);
        if (u.ok) return { text, endpoint, ...(u.osmBase ? { osmBase: u.osmBase } : {}) };
        lastError = u.reason;
      } else lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 160) : String(e);
      if (e instanceof TypeError) {
        connectionFailures.set(endpoint, (connectionFailures.get(endpoint) ?? 0) + 1);
        if (connectionFailures.get(endpoint) === 2) log(`    ${new URL(endpoint).host} unreachable twice; skipping it for the rest of this run`);
      }
    }
    const backoff = Math.min(120_000, 15_000 * 2 ** (attempt - 1));
    log(`    retry in ${Math.round(backoff / 1000)} s (attempt ${attempt}/${MAX_ATTEMPTS}, ${new URL(endpoint).host}: ${lastError})`);
    await sleep(backoff);
  }
  return { error: lastError, attempts: MAX_ATTEMPTS };
}

export async function acquire(id: string, log: (s: string) => void = console.log): Promise<Manifest> {
  const r = loadRegion(id);
  mkdirSync(join(cacheDir(id), 'tiles'), { recursive: true });
  const m = loadManifest(r);
  const jobs: { key: string; kind: TileKind; bbox: [number, number, number, number]; query: string }[] = [];
  for (const t of tilesOf(r)) {
    jobs.push({ ...t, kind: 'streets', query: streetQuery(t.bbox, r.roadClasses) });
    jobs.push({ ...t, kind: 'buildings', query: buildingQuery(t.bbox) });
  }
  jobs.push({ key: 'region', kind: 'restrictions', bbox: r.bbox, query: restrictionQuery(r.bbox) });
  let done = 0;
  for (const j of jobs) {
    const k = `${j.key}:${j.kind}`;
    if (m.entries[k]?.status === 'ok' || adoptExisting(r, m, j.key, j.kind, j.bbox)) {
      done++;
      continue;
    }
    const t0 = Date.now();
    log(`[${done + 1}/${jobs.length}] ${j.kind} ${j.key} ${j.bbox.join(',')}`);
    const res = await fetchOne(r, j.query, log);
    const file = `${j.key}_${j.kind}.json`;
    if ('text' in res) {
      writeFileSync(join(cacheDir(id), 'tiles', file), res.text);
      m.entries[k] = { key: j.key, kind: j.kind, bbox: j.bbox, status: 'ok', file, bytes: Buffer.byteLength(res.text), ...(res.osmBase ? { osmBase: res.osmBase } : {}), endpoint: res.endpoint, fetchedAt: new Date().toISOString(), attempts: (m.entries[k]?.attempts ?? 0) + 1 };
      log(`    ok ${(Buffer.byteLength(res.text) / 1024).toFixed(0)} KB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } else {
      m.entries[k] = { key: j.key, kind: j.kind, bbox: j.bbox, status: 'failed', file, attempts: (m.entries[k]?.attempts ?? 0) + res.attempts, lastError: res.error };
      log(`    FAILED after ${res.attempts} attempts: ${res.error} (rerun to resume)`);
    }
    done++;
    saveManifest(r, m);
    await sleep(MIN_INTERVAL_MS);
  }
  saveManifest(r, m);
  return m;
}

export function status(id: string): { total: number; ok: number; failed: string[]; missing: string[]; bytes: number } {
  const r = loadRegion(id);
  const m = loadManifest(r);
  const keys = [...tilesOf(r).flatMap((t) => [`${t.key}:streets`, `${t.key}:buildings`]), 'region:restrictions'];
  const ok = keys.filter((k) => m.entries[k]?.status === 'ok');
  return {
    total: keys.length,
    ok: ok.length,
    failed: keys.filter((k) => m.entries[k]?.status === 'failed'),
    missing: keys.filter((k) => !m.entries[k]),
    bytes: ok.reduce((s, k) => s + (m.entries[k]!.bytes ?? 0), 0),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const id = process.argv[2] ?? 'pune-bibwewadi';
  if (process.argv.includes('--status')) {
    const r = loadRegion(id);
    const m = loadManifest(r);
    for (const t of tilesOf(r)) for (const kind of ['streets', 'buildings'] as const) if (!m.entries[`${t.key}:${kind}`]) adoptExisting(r, m, t.key, kind, t.bbox);
    mkdirSync(cacheDir(id), { recursive: true });
    saveManifest(r, m);
    console.log(JSON.stringify(status(id), null, 1));
  } else {
    acquire(id)
      .then(() => console.log(JSON.stringify(status(id))))
      .catch((e: unknown) => {
        console.error(e);
        process.exit(1);
      });
  }
}
