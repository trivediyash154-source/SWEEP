/**
 * Place search for the map pages: type-ahead suggestions from Photon
 * (photon.komoot.io, an OpenStreetMap geocoder that allows autocomplete),
 * biased towards where the map is looking; Nominatim (explicit searches only,
 * one per second) when Photon cannot be reached. Coordinates typed as
 * "18.5204, 73.8567" are accepted without any service.
 * Data © OpenStreetMap contributors, ODbL.
 */
import { searchPlaces } from './maps';
import type { LngLat } from './directions';

export interface GeoPlace {
  id: string;
  /** Main line, e.g. "Shaniwar Wada". */
  label: string;
  /** Second line, e.g. "Shaniwar Peth, Pune, Maharashtra, India". */
  detail: string;
  lng: number;
  lat: number;
  /** OSM key:value, e.g. "tourism:attraction", when known. */
  kind: string | null;
  source: 'photon' | 'nominatim' | 'coordinates' | 'map';
}

const PHOTON = 'https://photon.komoot.io';
const TIMEOUT_MS = 8000;

/** "18.5204, 73.8567" or "18.5204 73.8567" (lat, lng). */
export function parseLatLng(text: string): LngLat | null {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

export function formatLatLng(p: LngLat): string {
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, unknown>;
}

/** Photon GeoJSON features → places (deduplicated by label and position). */
export function parsePhoton(json: unknown): GeoPlace[] {
  const features = (json as { features?: PhotonFeature[] })?.features;
  if (!Array.isArray(features)) return [];
  const out: GeoPlace[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const c = f.geometry?.coordinates;
    const p = f.properties ?? {};
    if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
    const str = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string).trim() : '');
    const street = [str('housenumber'), str('street')].filter(Boolean).join(' ');
    const label = str('name') || street || str('city') || str('state');
    if (!label) continue;
    const detail = [str('name') ? street : '', str('district'), str('locality'), str('city'), str('state'), str('country')]
      .filter((x, i, a) => x && x !== label && a.indexOf(x) === i)
      .join(', ');
    const key = `${label}|${c[0].toFixed(4)}|${c[1].toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `${str('osm_type') || 'x'}${String(p.osm_id ?? out.length)}`,
      label,
      detail,
      lng: c[0],
      lat: c[1],
      kind: str('osm_key') && str('osm_value') ? `${str('osm_key')}:${str('osm_value')}` : null,
      source: 'photon',
    });
  }
  return out;
}

const cache = new Map<string, GeoPlace[]>();

/** Suggestions for a partial query; `near` biases results towards the map view. */
export async function suggestPlaces(q: string, near: LngLat | null, signal?: AbortSignal): Promise<GeoPlace[]> {
  const query = q.trim().replace(/\s+/g, ' ');
  const coords = parseLatLng(query);
  if (coords) return [{ id: 'coords', label: formatLatLng(coords), detail: 'Coordinates (latitude, longitude)', ...coords, kind: null, source: 'coordinates' }];
  if (query.length < 3) return [];
  const key = `${query.toLowerCase()}|${near ? `${near.lat.toFixed(1)},${near.lng.toFixed(1)}` : ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const url = new URL(`${PHOTON}/api/`);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', '6');
  url.searchParams.set('lang', 'en');
  if (near) {
    url.searchParams.set('lat', near.lat.toFixed(4));
    url.searchParams.set('lon', near.lng.toFixed(4));
  }
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const places = parsePhoton(await res.json());
    cache.set(key, places);
    return places;
  } catch (err) {
    if (signal?.aborted) throw err;
    return [];
  }
}

/** An explicit search (Enter): Photon first, then Nominatim. */
export async function searchPlace(q: string, near: LngLat | null, signal?: AbortSignal): Promise<GeoPlace[]> {
  const fromPhoton = await suggestPlaces(q, near, signal);
  if (fromPhoton.length) return fromPhoton;
  const results = await searchPlaces(q, signal);
  return results.map((r, i) => {
    const [label, ...rest] = r.name.split(', ');
    return { id: `nominatim${i}`, label: label ?? r.name, detail: rest.join(', '), lng: r.lon, lat: r.lat, kind: r.type ?? null, source: 'nominatim' as const };
  });
}

/** A readable name for a clicked point (Photon reverse geocoding), or its coordinates. */
export async function describePoint(p: LngLat, signal?: AbortSignal): Promise<string> {
  const url = new URL(`${PHOTON}/reverse`);
  url.searchParams.set('lat', p.lat.toFixed(6));
  url.searchParams.set('lon', p.lng.toFixed(6));
  url.searchParams.set('lang', 'en');
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const [first] = parsePhoton(await res.json());
    return first ? [first.label, first.detail.split(', ')[0]].filter(Boolean).join(', ') : formatLatLng(p);
  } catch (err) {
    if (signal?.aborted) throw err;
    return formatLatLng(p);
  }
}
