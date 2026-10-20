/**
 * Door-to-door directions anywhere, from public OSRM servers on OpenStreetMap data.
 *
 * These routes are computed by OSRM (Open Source Routing Machine) on the server
 * that answers, not by SWEEP's own engine: SWEEP's exact algorithms run on the
 * networks it holds (the Pune extract, live-downloaded zones). The provider is
 * always named next to the result.
 *
 * Servers, tried in order for each mode:
 *  - FOSSGIS (routing.openstreetmap.de): car, bicycle and foot profiles, the
 *    service the openstreetmap.org website itself uses;
 *  - Project OSRM demo server (router.project-osrm.org): car only, as a fallback.
 * Both are free public services for light use; every request here is one user
 * action (no polling, no prefetching), and results are cached per query.
 */

export type TravelMode = 'car' | 'bike' | 'foot';
export interface LngLat {
  lng: number;
  lat: number;
}

export interface DirectionsStep {
  instruction: string;
  /** Street name or reference, '' when unnamed. */
  name: string;
  distanceM: number;
  durationS: number;
  /** [lng, lat] of the manoeuvre. */
  location: [number, number];
  type: string;
  modifier: string | null;
}

export interface DirectionsRoute {
  distanceM: number;
  durationS: number;
  /** [lng, lat] points of the whole route. */
  coordinates: [number, number][];
  steps: DirectionsStep[];
  /** The main streets of the route, for telling alternatives apart. */
  via: string;
}

export interface DirectionsProvider {
  id: string;
  name: string;
  base: string;
  profile: string;
  homepage: string;
}

export interface DirectionsResult {
  mode: TravelMode;
  provider: DirectionsProvider;
  routes: DirectionsRoute[];
  /** Providers tried before the one that answered, with the reason each failed. */
  failed: { provider: DirectionsProvider; reason: string }[];
}

export class DirectionsError extends Error {
  constructor(
    message: string,
    readonly code: 'NO_ROUTE' | 'UNAVAILABLE' | 'INVALID',
    readonly failed: { provider: DirectionsProvider; reason: string }[] = [],
  ) {
    super(message);
    this.name = 'DirectionsError';
  }
}

const FOSSGIS = 'https://routing.openstreetmap.de';
export const DIRECTIONS_PROVIDERS: Record<TravelMode, DirectionsProvider[]> = {
  car: [
    { id: 'fossgis-car', name: 'FOSSGIS OSRM, car profile', base: `${FOSSGIS}/routed-car`, profile: 'driving', homepage: 'https://routing.openstreetmap.de/' },
    { id: 'osrm-demo-car', name: 'Project OSRM demo server, car profile', base: 'https://router.project-osrm.org', profile: 'driving', homepage: 'https://project-osrm.org/' },
  ],
  bike: [{ id: 'fossgis-bike', name: 'FOSSGIS OSRM, bicycle profile', base: `${FOSSGIS}/routed-bike`, profile: 'driving', homepage: 'https://routing.openstreetmap.de/' }],
  foot: [{ id: 'fossgis-foot', name: 'FOSSGIS OSRM, foot profile', base: `${FOSSGIS}/routed-foot`, profile: 'driving', homepage: 'https://routing.openstreetmap.de/' }],
};

const TIMEOUT_MS = 15_000;

export function validPoint(p: LngLat): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}

export function osrmRouteUrl(provider: DirectionsProvider, from: LngLat, to: LngLat): string {
  const c = (p: LngLat): string => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;
  return `${provider.base}/route/v1/${provider.profile}/${c(from)};${c(to)}?overview=full&geometries=geojson&steps=true&alternatives=true`;
}

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/** Compass direction for a bearing in degrees (0 = north, clockwise). */
export function compass(bearing: number): string {
  return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;
}

interface OsrmManeuver {
  type?: string;
  modifier?: string;
  location?: [number, number];
  bearing_after?: number;
  exit?: number;
}
interface OsrmStep {
  name?: string;
  ref?: string;
  distance?: number;
  duration?: number;
  maneuver?: OsrmManeuver;
  rotary_name?: string;
}

/** A plain-English instruction for one OSRM step (the usual OSRM manoeuvre vocabulary). */
export function instructionFor(step: OsrmStep): string {
  const m = step.maneuver ?? {};
  const type = m.type ?? 'continue';
  const mod = m.modifier ?? null;
  const name = (step.name || step.ref || '').trim();
  const onto = name ? ` onto ${name}` : '';
  const on = name ? ` on ${name}` : '';
  const turnWord = (x: string | null): string => (x === 'uturn' ? 'make a U-turn' : x === 'straight' ? 'go straight' : x ? `turn ${x}` : 'continue');
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  switch (type) {
    case 'depart':
      return `Head ${typeof m.bearing_after === 'number' ? compass(m.bearing_after) : 'out'}${on}`;
    case 'arrive':
      return mod === 'left' || mod === 'right' ? `Arrive at your destination, on the ${mod}` : 'Arrive at your destination';
    case 'turn':
      return `${cap(turnWord(mod))}${onto}`;
    case 'new name':
      return `Continue${onto}`;
    case 'continue':
      return mod === 'uturn' ? `Make a U-turn${onto}` : mod && mod !== 'straight' ? `Continue ${mod}${onto}` : `Continue straight${onto}`;
    case 'merge':
      return `Merge${mod && mod !== 'straight' ? ` ${mod}` : ''}${onto}`;
    case 'on ramp':
      return `Take the ramp${mod && mod !== 'straight' ? ` on the ${mod.replace('slight ', '').replace('sharp ', '')}` : ''}${onto}`;
    case 'off ramp':
      return `Take the exit${mod && mod !== 'straight' ? ` on the ${mod.replace('slight ', '').replace('sharp ', '')}` : ''}${onto}`;
    case 'fork':
      return `Keep ${mod?.includes('left') ? 'left' : mod?.includes('right') ? 'right' : 'straight'} at the fork${onto}`;
    case 'end of road':
      return `At the end of the road, ${turnWord(mod)}${onto}`;
    case 'roundabout':
    case 'rotary': {
      const what = type === 'rotary' && step.rotary_name ? step.rotary_name : 'the roundabout';
      const exit = typeof m.exit === 'number' && m.exit >= 1 ? (ORDINAL[m.exit - 1] ?? `${m.exit}th`) : null;
      return exit ? `At ${what}, take the ${exit} exit${onto}` : `Enter ${what}${onto}`;
    }
    case 'roundabout turn':
      return `At the roundabout, ${turnWord(mod)}${onto}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Exit the roundabout${onto}`;
    case 'notification':
    default:
      return `Continue${on}`;
  }
}

/** Parse an OSRM /route response (geometries=geojson, steps=true). */
export function parseOsrmRoutes(json: unknown): DirectionsRoute[] {
  const j = json as { code?: string; message?: string; routes?: unknown[] };
  if (!j || typeof j !== 'object') throw new DirectionsError('The routing service returned something that is not a route.', 'INVALID');
  if (j.code === 'NoRoute' || j.code === 'NoSegment') throw new DirectionsError('No route connects these two points with this travel mode (for example, one of them is on an island, a private road or a road closed to this mode).', 'NO_ROUTE');
  if (j.code !== 'Ok' || !Array.isArray(j.routes) || j.routes.length === 0) throw new DirectionsError(`The routing service could not compute a route${j.message ? `: ${String(j.message).slice(0, 160)}` : '.'}`, 'INVALID');
  return j.routes.map((r) => {
    const route = r as { distance?: number; duration?: number; geometry?: { coordinates?: unknown }; legs?: { steps?: OsrmStep[] }[] };
    const coords = Array.isArray(route.geometry?.coordinates) ? (route.geometry!.coordinates as unknown[]).filter((c): c is [number, number] => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])).map((c) => [c[0], c[1]] as [number, number]) : [];
    const steps: DirectionsStep[] = (route.legs ?? []).flatMap((leg) =>
      (leg.steps ?? []).map((s) => ({
        instruction: instructionFor(s),
        name: (s.name || s.ref || '').trim(),
        distanceM: Number(s.distance) || 0,
        durationS: Number(s.duration) || 0,
        location: (Array.isArray(s.maneuver?.location) ? [s.maneuver!.location[0], s.maneuver!.location[1]] : coords[0] ?? [0, 0]) as [number, number],
        type: s.maneuver?.type ?? 'continue',
        modifier: s.maneuver?.modifier ?? null,
      })),
    );
    // The two longest named stretches tell alternatives apart ("via FC Road, JM Road").
    const byName = new Map<string, number>();
    for (const s of steps) if (s.name && s.type !== 'arrive') byName.set(s.name, (byName.get(s.name) ?? 0) + s.distanceM);
    const via = [...byName.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([n]) => n)
      .join(', ');
    return { distanceM: Number(route.distance) || 0, durationS: Number(route.duration) || 0, coordinates: coords, steps, via };
  });
}

const cache = new Map<string, DirectionsResult>();

/** Directions from `from` to `to`, trying each provider for the mode in turn. */
export async function fetchDirections(mode: TravelMode, from: LngLat, to: LngLat, signal?: AbortSignal): Promise<DirectionsResult> {
  if (!validPoint(from) || !validPoint(to)) throw new DirectionsError('Both points need valid coordinates.', 'INVALID');
  const key = `${mode}|${from.lng.toFixed(6)},${from.lat.toFixed(6)}|${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const failed: DirectionsResult['failed'] = [];
  for (const provider of DIRECTIONS_PROVIDERS[mode]) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(osrmRouteUrl(provider, from, to), { headers: { Accept: 'application/json' }, signal: sig });
    } catch (err) {
      if (signal?.aborted) throw err;
      failed.push({ provider, reason: timeout.aborted ? `no answer within ${TIMEOUT_MS / 1000} s` : 'not reachable from this browser' });
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      failed.push({ provider, reason: res.status === 429 ? 'busy (HTTP 429, too many requests)' : `busy (HTTP ${res.status})` });
      continue;
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      failed.push({ provider, reason: `answered HTTP ${res.status} without a route` });
      continue;
    }
    try {
      const result: DirectionsResult = { mode, provider, routes: parseOsrmRoutes(json), failed };
      cache.set(key, result);
      return result;
    } catch (err) {
      if (err instanceof DirectionsError && err.code === 'NO_ROUTE') throw new DirectionsError(err.message, 'NO_ROUTE', failed);
      failed.push({ provider, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  throw new DirectionsError(`No routing service answered: ${failed.map((f) => `${f.provider.name}: ${f.reason}`).join('; ')}.`, 'UNAVAILABLE', failed);
}

/** "1 h 05 min", "12 min", "45 s". */
export function formatTravelTime(s: number): string {
  if (!Number.isFinite(s)) return '–';
  if (s < 60) return `${Math.max(0, Math.round(s))} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

/** "850 m", "12.4 km", "128 km". */
export function formatTravelDistance(m: number): string {
  if (!Number.isFinite(m)) return '–';
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  if (m < 100_000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}
