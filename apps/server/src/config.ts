import { existsSync } from 'node:fs';

/** Public Overpass API instances tried in order for live map acquisition (overpass.osm.ch covers Switzerland only). */
// Order: the main public instance, then instances that answered quickly in testing; the
// Swiss instance is used only for areas in Switzerland; the slow mail.ru instance last.
export const DEFAULT_OVERPASS_ENDPOINTS: readonly string[] = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
export const DEFAULT_NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/** Comma-separated http(s) URLs; invalid entries are ignored. Returns null when nothing usable is given. */
function urlList(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => {
      try {
        const u = new URL(s);
        return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password;
      } catch {
        return false;
      }
    });
  return list.length ? list : null;
}

export interface ServerConfig {
  port: number;
  host: string;
  dbPath: string;
  /** Directory of the built web app to serve (optional). */
  staticDir: string | null;
  /** Set the Secure flag on cookies. Defaults to true in production. */
  secureCookies: boolean;
  /** Trust X-Forwarded-For for client IPs (only behind a trusted proxy). */
  trustProxy: boolean;
  /** Run optimisations in a worker thread with a hard timeout. */
  solverMode: 'worker' | 'inline';
  solverTimeoutMs: number;
  sessionTtlMs: number;
  /** Disable rate limiting (tests only). */
  rateLimit: boolean;
  /** Live map acquisition (Overpass API) and place search (Nominatim). SWEEP_MAP_ACQUISITION=off disables both. */
  mapAcquisition: boolean;
  /** Overpass API endpoints tried in order (SWEEP_OVERPASS_ENDPOINTS, comma-separated). */
  overpassEndpoints: string[];
  /** Nominatim search endpoint (SWEEP_NOMINATIM_ENDPOINT). */
  nominatimEndpoint: string;
  /** Directory for cached Overpass responses (SWEEP_MAP_CACHE_DIR); created on first use. */
  mapCacheDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.SWEEP_DB_PATH ?? 'data/sweep.db',
    // Serve the built web app automatically when it exists next to the server (pnpm start).
    staticDir: env.SWEEP_STATIC_DIR ?? (existsSync('apps/web/dist/index.html') ? 'apps/web/dist' : null),
    secureCookies: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : production,
    trustProxy: env.TRUST_PROXY === 'true',
    solverMode: env.SWEEP_SOLVER_MODE === 'inline' ? 'inline' : 'worker',
    solverTimeoutMs: Number(env.SWEEP_SOLVER_TIMEOUT_MS ?? 20_000),
    sessionTtlMs: Number(env.SWEEP_SESSION_TTL_MS ?? 7 * 24 * 3600 * 1000),
    rateLimit: env.SWEEP_RATE_LIMIT !== 'off',
    mapAcquisition: env.SWEEP_MAP_ACQUISITION !== 'off',
    overpassEndpoints: urlList(env.SWEEP_OVERPASS_ENDPOINTS) ?? [...DEFAULT_OVERPASS_ENDPOINTS],
    nominatimEndpoint: urlList(env.SWEEP_NOMINATIM_ENDPOINT)?.[0] ?? DEFAULT_NOMINATIM_ENDPOINT,
    mapCacheDir: env.SWEEP_MAP_CACHE_DIR ?? 'data/map-cache',
  };
}
