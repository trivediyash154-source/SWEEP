import type { Edge, Graph, Point, Vertex } from './types.js';

/**
 * GeoJSON → SWEEP graph conversion.
 *
 * Accepted input: a FeatureCollection (or single Feature) whose features have
 * LineString or MultiLineString geometry in WGS84 [longitude, latitude].
 * Other geometry types are skipped and reported.
 *
 * Conversion rules (documented in MATHEMATICAL_SPEC.md):
 * 1. Coordinates are snapped to 1e-7° (≈1 cm) to identify shared points.
 * 2. A coordinate becomes an intersection (vertex) if it is the first or last
 *    point of a line, or if it occurs in two or more places across all lines.
 * 3. Each line is split at its intersections; every piece becomes one edge
 *    whose interior points are kept as the drawn shape.
 * 4. Edge weight = geodesic length in metres (haversine, R = 6,371,008.8 m).
 * 5. Planar drawing coordinates use a local equirectangular projection centred
 *    on the data's mean latitude/longitude (metres, y pointing south).
 * 6. Feature property `required: false` marks a street optional (default:
 *    required). `name` is kept. `oneway` is reported as unsupported and ignored.
 */
export interface GeoJsonImportReport {
  graph: Graph;
  featureCount: number;
  lineCount: number;
  skippedFeatures: { index: number; reason: string }[];
  warnings: string[];
}

const R = 6_371_008.8;
const MAX_COORDS = 50_000;
const MAX_FEATURES = 10_000;

function haversine(a: Point, b: Point): number {
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function isLonLat(p: unknown): p is Point {
  return Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number' && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
}

export class GeoJsonImportError extends Error {}

export function geojsonToGraph(input: unknown, name = 'Imported network'): GeoJsonImportReport {
  if (typeof input !== 'object' || input === null) throw new GeoJsonImportError('The file is not a JSON object.');
  const obj = input as { type?: unknown; features?: unknown; geometry?: unknown; properties?: unknown };
  let features: unknown[];
  if (obj.type === 'FeatureCollection') {
    if (!Array.isArray(obj.features)) throw new GeoJsonImportError('FeatureCollection has no "features" array.');
    features = obj.features;
  } else if (obj.type === 'Feature') features = [obj];
  else throw new GeoJsonImportError('Expected a GeoJSON FeatureCollection or Feature.');
  if (features.length > MAX_FEATURES) throw new GeoJsonImportError(`Too many features (${features.length}); the limit is ${MAX_FEATURES}.`);

  const skipped: { index: number; reason: string }[] = [];
  const warnings: string[] = [];
  const lines: { coords: Point[]; required: boolean; name?: string }[] = [];
  let coordCount = 0;
  let onewayCount = 0;

  features.forEach((f, index) => {
    const feat = f as { type?: unknown; geometry?: { type?: unknown; coordinates?: unknown } | null; properties?: Record<string, unknown> | null };
    if (feat?.type !== 'Feature' || !feat.geometry) {
      skipped.push({ index, reason: 'Not a Feature with geometry.' });
      return;
    }
    const props = feat.properties ?? {};
    const required = props.required === false || props.required === 'false' ? false : true;
    const nm = typeof props.name === 'string' ? props.name.slice(0, 120) : undefined;
    if (props.oneway === true || props.oneway === 'yes' || props.oneway === '1') onewayCount++;
    const g = feat.geometry;
    const parts: unknown[] = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' && Array.isArray(g.coordinates) ? (g.coordinates as unknown[]) : [];
    if (parts.length === 0) {
      skipped.push({ index, reason: `Unsupported geometry type ${JSON.stringify(g.type)} (only LineString and MultiLineString describe streets).` });
      return;
    }
    for (const part of parts) {
      if (!Array.isArray(part) || part.length < 2 || !part.every(isLonLat)) {
        skipped.push({ index, reason: 'A line has fewer than 2 points or invalid [longitude, latitude] coordinates.' });
        continue;
      }
      coordCount += part.length;
      if (coordCount > MAX_COORDS) throw new GeoJsonImportError(`Too many coordinates; the limit is ${MAX_COORDS}.`);
      const coords = (part as Point[]).map((p) => [Math.round(p[0] * 1e7) / 1e7, Math.round(p[1] * 1e7) / 1e7] as Point);
      // drop consecutive duplicates
      const clean: Point[] = [coords[0]!];
      for (let i = 1; i < coords.length; i++) {
        const a = clean[clean.length - 1]!;
        const b = coords[i]!;
        if (a[0] !== b[0] || a[1] !== b[1]) clean.push(b);
      }
      if (clean.length < 2) {
        skipped.push({ index, reason: 'A line collapses to a single point.' });
        continue;
      }
      lines.push({ coords: clean, required, ...(nm ? { name: nm } : {}) });
    }
  });
  if (lines.length === 0) throw new GeoJsonImportError('No usable LineString street geometry was found.');
  if (onewayCount > 0) warnings.push(`${onewayCount} feature(s) are marked one-way; SWEEP treats every street as two-way in this version.`);

  const key = (p: Point): string => `${p[0]},${p[1]}`;
  const occurrences = new Map<string, number>();
  for (const l of lines) for (const p of l.coords) occurrences.set(key(p), (occurrences.get(key(p)) ?? 0) + 1);
  const isNode = (l: { coords: Point[] }, i: number): boolean => i === 0 || i === l.coords.length - 1 || (occurrences.get(key(l.coords[i]!)) ?? 0) > 1;

  let sumLon = 0;
  let sumLat = 0;
  let cnt = 0;
  for (const l of lines) for (const p of l.coords) {
    sumLon += p[0];
    sumLat += p[1];
    cnt++;
  }
  const lon0 = sumLon / cnt;
  const lat0 = sumLat / cnt;
  const kx = (Math.PI / 180) * R * Math.cos((lat0 * Math.PI) / 180);
  const ky = (Math.PI / 180) * R;
  const project = (p: Point): Point => [Math.round((p[0] - lon0) * kx * 100) / 100, Math.round(-(p[1] - lat0) * ky * 100) / 100];

  const vertexIds = new Map<string, string>();
  const vertices: Vertex[] = [];
  const vertexFor = (p: Point): string => {
    const k = key(p);
    let id = vertexIds.get(k);
    if (!id) {
      id = `n${vertices.length}`;
      vertexIds.set(k, id);
      const [x, y] = project(p);
      vertices.push({ id, x, y });
    }
    return id;
  };

  const edges: Edge[] = [];
  for (const l of lines) {
    let startIdx = 0;
    for (let i = 1; i < l.coords.length; i++) {
      if (!isNode(l, i)) continue;
      const piece = l.coords.slice(startIdx, i + 1);
      let len = 0;
      for (let j = 1; j < piece.length; j++) len += haversine(piece[j - 1]!, piece[j]!);
      const u = vertexFor(piece[0]!);
      const v = vertexFor(piece[piece.length - 1]!);
      const shape = piece.slice(1, -1).map(project);
      edges.push({
        id: `s${edges.length}`,
        u,
        v,
        weight: Math.round(len * 10) / 10,
        required: l.required,
        ...(l.name ? { name: l.name } : {}),
        ...(shape.length ? { shape } : {}),
      });
      startIdx = i;
    }
  }
  return {
    graph: { format: 'sweep.graph', version: 1, name, units: 'm', vertices, edges },
    featureCount: features.length,
    lineCount: lines.length,
    skippedFeatures: skipped,
    warnings,
  };
}
