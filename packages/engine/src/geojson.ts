import type { Edge, Graph, Point, Vertex } from './types.js';
import { localProjection, polylineLength } from './geo.js';

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
 * 4. Edge weight = geodesic length in metres (haversine, R = 6,371,008.8 m; see geo.ts).
 * 5. Planar drawing coordinates use a local equirectangular projection centred
 *    on the data's mean latitude/longitude (metres, y pointing south). Every
 *    vertex also keeps its geographic position in `geo` ([lon, lat]).
 * 6. Feature property `required: false` marks a street optional (default:
 *    required). `name` is kept; a string `highway` property is kept as `roadClass`.
 * 7. One-way streets (OpenStreetMap conventions): property `oneway` equal to
 *    true, "yes", "1" or "true" marks every piece `oneway: true` in the line's
 *    drawing direction; "-1" (or -1) means one-way AGAINST the drawing
 *    direction, so each piece is stored reversed (u and v swapped, shape
 *    reversed). "no", false or no property means two-way. Other values (for
 *    example "reversible") are treated as two-way and reported as a warning.
 * 8. `graph.source` records kind "imported-file" with the conversion notes. A
 *    feature id or "@id" such as "way/123" (Overpass Turbo export) is kept as
 *    `sourceRef: "osm:way/123"`.
 */
export interface GeoJsonImportReport {
  graph: Graph;
  featureCount: number;
  lineCount: number;
  skippedFeatures: { index: number; reason: string }[];
  /** Problems the user should know about (unrecognised one-way values, …). */
  warnings: string[];
  /** Informative conversion notes (one-way counts, …); also stored in graph.source.notes. */
  notes: string[];
}

const MAX_COORDS = 50_000;
const MAX_FEATURES = 10_000;

type Direction = 'two-way' | 'forward' | 'reverse';

function isLonLat(p: unknown): p is Point {
  return Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number' && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
}

/** Interpret a GeoJSON `oneway` property; `null` means an unrecognised value (treated as two-way). */
function onewayDirection(value: unknown): Direction | null {
  if (value === undefined || value === null || value === false) return 'two-way';
  if (value === true || value === 1) return 'forward';
  if (value === -1) return 'reverse';
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (v === 'yes' || v === '1' || v === 'true') return 'forward';
  if (v === '-1') return 'reverse';
  if (v === 'no' || v === 'false' || v === '0' || v === '') return 'two-way';
  return null;
}

function osmRef(feat: { id?: unknown; properties?: Record<string, unknown> | null }): string | undefined {
  const raw = typeof feat.id === 'string' ? feat.id : typeof feat.properties?.['@id'] === 'string' ? (feat.properties['@id'] as string) : undefined;
  const m = raw ? /^(way|node|relation)\/(\d{1,15})$/.exec(raw) : null;
  return m ? `osm:${m[1]}/${m[2]}` : undefined;
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
  const notes: string[] = [];
  const lines: { coords: Point[]; required: boolean; name?: string; direction: Direction; roadClass?: string; sourceRef?: string }[] = [];
  let coordCount = 0;
  const onewayFeatures = { forward: 0, reverse: 0 };
  const unknownOneway = new Map<string, number>();

  features.forEach((f, index) => {
    const feat = f as { type?: unknown; id?: unknown; geometry?: { type?: unknown; coordinates?: unknown } | null; properties?: Record<string, unknown> | null };
    if (feat?.type !== 'Feature' || !feat.geometry) {
      skipped.push({ index, reason: 'Not a Feature with geometry.' });
      return;
    }
    const props = feat.properties ?? {};
    const required = props.required === false || props.required === 'false' ? false : true;
    const nm = typeof props.name === 'string' ? props.name.slice(0, 120) : undefined;
    const roadClass = typeof props.highway === 'string' && props.highway.trim() ? props.highway.trim().slice(0, 40) : undefined;
    const sourceRef = osmRef(feat);
    let direction = onewayDirection(props.oneway);
    if (direction === null) {
      const label = String(props.oneway).slice(0, 40);
      unknownOneway.set(label, (unknownOneway.get(label) ?? 0) + 1);
      direction = 'two-way';
    }
    const g = feat.geometry;
    const parts: unknown[] = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' && Array.isArray(g.coordinates) ? (g.coordinates as unknown[]) : [];
    if (parts.length === 0) {
      skipped.push({ index, reason: `Unsupported geometry type ${JSON.stringify(g.type)} (only LineString and MultiLineString describe streets).` });
      return;
    }
    let usable = false;
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
      usable = true;
      lines.push({ coords: clean, required, direction, ...(nm ? { name: nm } : {}), ...(roadClass ? { roadClass } : {}), ...(sourceRef ? { sourceRef } : {}) });
    }
    if (usable && direction !== 'two-way') onewayFeatures[direction]++;
  });
  if (lines.length === 0) throw new GeoJsonImportError('No usable LineString street geometry was found.');

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
  const project = localProjection(sumLon / cnt, sumLat / cnt);

  const vertexIds = new Map<string, string>();
  const vertices: Vertex[] = [];
  const vertexFor = (p: Point): string => {
    const k = key(p);
    let id = vertexIds.get(k);
    if (!id) {
      id = `n${vertices.length}`;
      vertexIds.set(k, id);
      const [x, y] = project(p);
      vertices.push({ id, x, y, geo: [p[0], p[1]] });
    }
    return id;
  };

  const edges: Edge[] = [];
  let onewayEdges = 0;
  for (const l of lines) {
    let startIdx = 0;
    for (let i = 1; i < l.coords.length; i++) {
      if (!isNode(l, i)) continue;
      const piece = l.coords.slice(startIdx, i + 1);
      const len = polylineLength(piece);
      // Vertices are created in drawing order so that ids do not depend on the one-way direction.
      const a = vertexFor(piece[0]!);
      const b = vertexFor(piece[piece.length - 1]!);
      const reverse = l.direction === 'reverse';
      const interior = piece.slice(1, -1);
      if (reverse) interior.reverse();
      const shape = interior.map(project);
      const oneway = l.direction !== 'two-way';
      if (oneway) onewayEdges++;
      edges.push({
        id: `s${edges.length}`,
        u: reverse ? b : a,
        v: reverse ? a : b,
        weight: Math.round(len * 10) / 10,
        required: l.required,
        ...(l.name ? { name: l.name } : {}),
        ...(shape.length ? { shape } : {}),
        ...(oneway ? { oneway: true } : {}),
        ...(l.roadClass ? { roadClass: l.roadClass } : {}),
        ...(l.sourceRef ? { sourceRef: l.sourceRef } : {}),
      });
      startIdx = i;
    }
  }

  const onewayFeatureCount = onewayFeatures.forward + onewayFeatures.reverse;
  if (onewayFeatureCount > 0) {
    notes.push(
      `${onewayFeatureCount} one-way street${onewayFeatureCount === 1 ? '' : 's'} (${onewayEdges} segment${onewayEdges === 1 ? '' : 's'}) kept with their direction` +
        (onewayFeatures.reverse > 0 ? `; ${onewayFeatures.reverse} tagged oneway=-1 were stored reversed` : '') +
        '. Use directed routing to respect them.',
    );
  } else notes.push('No one-way streets: every street is two-way.');
  if (unknownOneway.size > 0) {
    const list = [...unknownOneway.entries()].map(([v, n]) => `"${v}" (${n})`).join(', ');
    warnings.push(`Unrecognised oneway value(s) ${list} were treated as two-way.`);
  }
  if (skipped.length > 0) notes.push(`${skipped.length} feature part(s) skipped (not street lines or invalid coordinates).`);

  return {
    graph: {
      format: 'sweep.graph',
      version: 1,
      name,
      units: 'm',
      vertices,
      edges,
      source: { kind: 'imported-file', provider: 'GeoJSON file', notes: [...notes, ...warnings].slice(0, 50) },
    },
    featureCount: features.length,
    lineCount: lines.length,
    skippedFeatures: skipped,
    warnings,
    notes,
  };
}
