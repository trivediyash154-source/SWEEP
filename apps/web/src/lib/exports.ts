import { edgesToCsv, fleetToCsv, routeToCsv, type FleetRecord, type Graph, type RoutingSettings, type SingleRouteRecord } from '@sweep/engine';
import { downloadText, safeFileName, writeJson } from './storage';
import { edgePoints, vertexMap } from './geometry';

export const REPORT_KEY = 'sweep.lastReport.v2';

export interface ExportInput {
  name: string;
  graph: Graph;
  result: SingleRouteRecord | null;
  fleet: FleetRecord | null;
  settings: Required<RoutingSettings> | null;
  source: 'server' | 'browser' | null;
}

/** Everything needed to reproduce and audit a run, in one JSON document. */
export function exportBundle(x: ExportInput) {
  return {
    format: 'sweep.export',
    version: 2,
    exportedAt: new Date().toISOString(),
    scenario: x.name,
    provenance: x.graph.source ?? { kind: 'user' },
    attribution: x.graph.source?.attribution ?? null,
    settings: x.settings,
    engineSource: x.source,
    graph: x.graph,
    result: x.result,
    fleet: x.fleet,
  };
}

export function downloadJson(x: ExportInput): void {
  downloadText(`${safeFileName(x.name)}-sweep.json`, JSON.stringify(exportBundle(x), null, 2), 'application/json');
}

export function downloadRouteCsv(x: ExportInput): void {
  if (!x.result) return;
  downloadText(`${safeFileName(x.name)}-route.csv`, routeToCsv(x.result, x.graph), 'text/csv');
}

export function downloadStreetsCsv(x: ExportInput): void {
  if (!x.result) return;
  downloadText(`${safeFileName(x.name)}-streets.csv`, edgesToCsv(x.result, x.graph), 'text/csv');
}

export function downloadFleetCsv(x: ExportInput): void {
  if (!x.fleet) return;
  downloadText(`${safeFileName(x.name)}-fleet.csv`, fleetToCsv(x.fleet, x.graph), 'text/csv');
}

/**
 * Fit the local projection used for map data (x = (lon − lon0)·kx, y = −(lat − lat0)·ky)
 * from vertices that carry both planar and geographic coordinates, so interior
 * shape points can be converted back to longitude/latitude.
 */
function inverseProjection(graph: Graph): ((p: [number, number]) => [number, number]) | null {
  const pts = graph.vertices.filter((v) => v.geo);
  if (pts.length < 3 || pts.length !== graph.vertices.length) return null;
  const fit = (xs: number[], ys: number[]) => {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i]! - mx) * (ys[i]! - my);
      sxx += (xs[i]! - mx) ** 2;
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    return { slope, intercept: my - slope * mx };
  };
  const lon = fit(pts.map((v) => v.x), pts.map((v) => v.geo![0]));
  const lat = fit(pts.map((v) => v.y), pts.map((v) => v.geo![1]));
  if (lon.slope === 0 || lat.slope === 0) return null;
  return (p) => [Math.round((lon.intercept + lon.slope * p[0]) * 1e7) / 1e7, Math.round((lat.intercept + lat.slope * p[1]) * 1e7) / 1e7];
}

/** GeoJSON of the network with per-street route statistics. */
export function graphToGeoJson(graph: Graph, result: SingleRouteRecord | null) {
  const vm = vertexMap(graph);
  const inv = inverseProjection(graph);
  const geoOf = new Map(graph.vertices.map((v) => [v.id, v.geo]));
  const added = result ? (result.mode === 'directed' ? result.augmentation.addedEdgeCopies : result.augmentation.addedCopies) : {};
  return {
    type: 'FeatureCollection',
    ...(inv ? {} : { crs_note: 'Local planar coordinates (this network has no geographic positions); not WGS84.' }),
    ...(graph.source?.attribution ? { attribution: graph.source.attribution, license: graph.source.license } : {}),
    features: graph.edges.map((e) => {
      const pts = edgePoints(e, vm);
      const coords = inv
        ? pts.map((p, i) => (i === 0 ? geoOf.get(e.u)! : i === pts.length - 1 ? geoOf.get(e.v)! : inv(p as [number, number])))
        : pts;
      return {
        type: 'Feature',
        properties: {
          id: e.id,
          name: e.name ?? null,
          length: e.weight,
          required: e.required,
          oneway: e.oneway === true,
          ...(e.sourceRef ? { source: e.sourceRef } : {}),
          traversals: result?.route.traversalCounts[e.id] ?? null,
          added_copies: result ? (added[e.id] ?? 0) : null,
        },
        geometry: { type: 'LineString', coordinates: coords },
      };
    }),
  };
}

export function downloadGeoJson(x: ExportInput): void {
  downloadText(`${safeFileName(x.name)}.geojson`, JSON.stringify(graphToGeoJson(x.graph, x.result), null, 1), 'application/geo+json');
}

/** Store the current run for the printable report page. */
export function prepareReport(x: ExportInput): boolean {
  if (!x.result) return false;
  return writeJson(REPORT_KEY, { name: x.name, graph: x.graph, result: x.result, fleet: x.fleet, settings: x.settings, source: x.source, savedAt: Date.now() });
}
