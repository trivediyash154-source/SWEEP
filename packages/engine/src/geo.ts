import type { Point } from './types.js';

/**
 * Geodesy helpers shared by the map importers (GeoJSON and OpenStreetMap).
 *
 * - Points are [longitude, latitude] in WGS84 degrees, as in GeoJSON.
 * - Lengths use the haversine formula on a sphere of mean Earth radius
 *   R = 6,371,008.8 m (IUGG). The error against the ellipsoid is below 0.5 %,
 *   far smaller than the uncertainty of mapped street centrelines.
 * - Drawing coordinates use a local equirectangular projection centred on
 *   (lon0, lat0): metres east (x) and metres SOUTH (y, matching screen space),
 *   rounded to 1 cm. Distortion is negligible over the few-kilometre extents
 *   SWEEP accepts.
 */

/** Mean Earth radius in metres (IUGG). */
export const EARTH_RADIUS_M = 6_371_008.8;

/** Bounding box [south, west, north, east] in degrees. */
export type BBox = [south: number, west: number, north: number, east: number];

const TO_RAD = Math.PI / 180;

/** Great-circle distance in metres between two [lon, lat] points. */
export function haversine(a: Point, b: Point): number {
  const dLat = (b[1] - a[1]) * TO_RAD;
  const dLon = (b[0] - a[0]) * TO_RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * TO_RAD) * Math.cos(b[1] * TO_RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Length in metres of a [lon, lat] polyline (sum of haversine segment lengths). */
export function polylineLength(points: readonly Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += haversine(points[i - 1]!, points[i]!);
  return len;
}

/**
 * Local equirectangular projection centred on (lon0, lat0).
 * Returns a function mapping [lon, lat] to [x, y] in metres (x east, y south), rounded to 1 cm.
 */
export function localProjection(lon0: number, lat0: number): (p: Point) => Point {
  const kx = TO_RAD * EARTH_RADIUS_M * Math.cos((lat0 * Math.PI) / 180);
  const ky = TO_RAD * EARTH_RADIUS_M;
  return (p: Point): Point => [Math.round((p[0] - lon0) * kx * 100) / 100, Math.round(-(p[1] - lat0) * ky * 100) / 100];
}

/**
 * Area in km² of a latitude/longitude rectangle on the sphere:
 * R² · Δλ · (sin φ_north − sin φ_south). Returns 0 for inverted boxes.
 */
export function bboxAreaKm2(bbox: readonly [number, number, number, number]): number {
  const [s, w, n, e] = bbox;
  if (!(n > s) || !(e > w)) return 0;
  const rKm = EARTH_RADIUS_M / 1000;
  return rKm * rKm * (e - w) * TO_RAD * (Math.sin(n * TO_RAD) - Math.sin(s * TO_RAD));
}

/** Width (east–west, measured along the middle latitude) and height (north–south) of a bbox in metres. */
export function bboxSizeMetres(bbox: readonly [number, number, number, number]): { width: number; height: number } {
  const [s, w, n, e] = bbox;
  const mid = (s + n) / 2;
  return { width: haversine([w, mid], [e, mid]), height: haversine([w, s], [w, n]) };
}
