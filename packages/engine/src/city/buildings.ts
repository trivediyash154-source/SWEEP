import type { Point } from '../types.js';
import { STOREY_HEIGHT_M, type HeightSource } from './types.js';

/**
 * Building footprints and heights.
 *
 * Height, in order of preference:
 *  1. `height` tag: metres ("12", "12.5", "12 m"); values in feet ("40'", "40 ft")
 *     are converted. Accepted when 2 m ≤ h ≤ 500 m.            → source 'height'
 *  2. `building:levels` tag: integer 1…150 (plus `roof:levels` when present),
 *     multiplied by STOREY_HEIGHT_M (3.0 m, an assumption).    → source 'levels'
 *  3. Otherwise a documented VISUAL ESTIMATE, never presented as measured:
 *     a level count from the OSM `building` value where it implies one,
 *     else from footprint area bands, multiplied by 3.0 m.     → source 'estimate'
 */

export const HEIGHT_RANGE_M: readonly [number, number] = [2, 500];
export const LEVELS_RANGE: readonly [number, number] = [1, 150];

/** Level counts implied by the building type (used only when no height or levels are tagged). */
export const KIND_LEVELS: Readonly<Record<string, number>> = {
  shed: 1,
  hut: 1,
  garage: 1,
  garages: 1,
  carport: 1,
  roof: 1,
  kiosk: 1,
  toilets: 1,
  service: 1,
  outbuilding: 1,
  cabin: 1,
  transformer_tower: 1,
  temple: 2,
  church: 2,
  mosque: 2,
  house: 2,
  detached: 2,
  semidetached_house: 2,
  bungalow: 2,
  terrace: 2,
  industrial: 2,
  warehouse: 2,
  school: 3,
  college: 3,
  university: 3,
  hospital: 3,
  public: 3,
  civic: 3,
  government: 3,
  retail: 3,
  commercial: 4,
  office: 4,
  hotel: 4,
  dormitory: 4,
  apartments: 5,
  residential: 4,
  flats: 5,
};

/** Footprint area bands (m², exclusive upper bound) → estimated levels, for untyped buildings. */
export const AREA_LEVEL_BANDS: readonly (readonly [number, number])[] = [
  [40, 1],
  [120, 2],
  [400, 3],
  [1200, 4],
  [Infinity, 5],
];

/** Parse an OSM `height` value to metres, or null when absent or not plausible. */
export function parseHeight(raw: string | undefined): number | null {
  if (raw == null) return null;
  const s = raw.trim().toLowerCase();
  let m = /^(\d+(?:\.\d+)?)\s*(m|metres|meters)?$/.exec(s);
  let h: number | null = null;
  if (m) h = Number(m[1]);
  else if ((m = /^(\d+(?:\.\d+)?)\s*(ft|feet|')$/.exec(s))) h = Number(m[1]) * 0.3048;
  else if ((m = /^(\d+)'\s*(\d+)"?$/.exec(s))) h = Number(m[1]) * 0.3048 + Number(m[2]) * 0.0254;
  if (h === null || !Number.isFinite(h) || h < HEIGHT_RANGE_M[0] || h > HEIGHT_RANGE_M[1]) return null;
  return Math.round(h * 10) / 10;
}

/** Parse an OSM level count (`building:levels`, `roof:levels`), or null. */
export function parseLevels(raw: string | undefined): number | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (!/^\d+(\.5)?$/.test(s)) return null;
  const n = Number(s);
  return n >= LEVELS_RANGE[0] && n <= LEVELS_RANGE[1] ? n : null;
}

export interface HeightResult {
  height: number;
  source: HeightSource;
  /** Tagged `building:levels`, when valid. */
  levels: number | null;
}

export function buildingHeight(tags: Record<string, string>, footprintAreaM2: number): HeightResult {
  const levels = parseLevels(tags['building:levels']);
  const h = parseHeight(tags.height);
  if (h !== null) return { height: h, source: 'height', levels };
  if (levels !== null) {
    const roof = parseLevels(tags['roof:levels']) ?? 0;
    return { height: Math.round((levels + roof) * STOREY_HEIGHT_M * 10) / 10, source: 'levels', levels };
  }
  return { height: estimateLevels(tags.building, footprintAreaM2) * STOREY_HEIGHT_M, source: 'estimate', levels: null };
}

/** Estimated level count (visual context only). */
export function estimateLevels(kind: string | undefined, areaM2: number): number {
  const k = kind?.trim().toLowerCase();
  if (k && KIND_LEVELS[k] !== undefined) return KIND_LEVELS[k]!;
  for (const [upper, lv] of AREA_LEVEL_BANDS) if (areaM2 < upper) return lv;
  return 5;
}

/** Signed shoelace area of an open ring (positive when counter-clockwise in a y-up frame). */
export function signedArea(ring: readonly Point[]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const o = (p: Point, q: Point, r: Point): number => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

export type RingProblem = 'too-few-points' | 'not-closed' | 'zero-area' | 'self-intersecting' | 'too-many-points';

export const MAX_RING_POINTS = 4000;
export const MIN_FOOTPRINT_M2 = 1;

/**
 * Validate a closed ring given in metres (first point repeated at the end, as
 * OSM delivers it). Returns the cleaned open ring (consecutive duplicates
 * removed, closing point dropped), wound so that signedArea > 0, or the reason
 * it was rejected.
 */
export function cleanRing(closed: readonly Point[]): { ok: true; ring: Point[]; area: number } | { ok: false; problem: RingProblem } {
  if (closed.length < 4) return { ok: false, problem: 'too-few-points' };
  if (closed.length > MAX_RING_POINTS) return { ok: false, problem: 'too-many-points' };
  const f = closed[0]!;
  const l = closed[closed.length - 1]!;
  if (f[0] !== l[0] || f[1] !== l[1]) return { ok: false, problem: 'not-closed' };
  const ring: Point[] = [];
  for (let i = 0; i < closed.length - 1; i++) {
    const p = closed[i]!;
    const prev = ring[ring.length - 1];
    if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
    ring.push([p[0], p[1]]);
  }
  while (ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1]) ring.pop();
  if (ring.length < 3) return { ok: false, problem: 'too-few-points' };
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent through the closing edge
      if (segmentsCross(ring[i]!, ring[(i + 1) % n]!, ring[j]!, ring[(j + 1) % n]!)) return { ok: false, problem: 'self-intersecting' };
    }
  }
  let area = signedArea(ring);
  if (Math.abs(area) < MIN_FOOTPRINT_M2) return { ok: false, problem: 'zero-area' };
  if (area < 0) {
    ring.reverse();
    area = -area;
  }
  return { ok: true, ring, area };
}

export function ringCentroid(ring: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}
