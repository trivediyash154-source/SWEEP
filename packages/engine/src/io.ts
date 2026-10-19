import type { DataProvenance, FleetRecord, Graph, Point, RoutingSettings, SingleRouteRecord } from './types.js';

export class GraphParseError extends Error {}

const MAX_JSON_BYTES = 5 * 1024 * 1024;

/**
 * Parse a SWEEP graph document. Only plain JSON parsing is performed (never
 * eval); unknown fields are dropped. Semantic checks are done by validateGraph.
 */
export function parseGraphJson(text: string): Graph {
  if (text.length > MAX_JSON_BYTES) throw new GraphParseError('File is larger than 5 MB.');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GraphParseError('The file is not valid JSON.');
  }
  return coerceGraph(raw);
}

export function coerceGraph(raw: unknown): Graph {
  if (typeof raw !== 'object' || raw === null) throw new GraphParseError('Expected a JSON object.');
  const o = raw as Record<string, unknown>;
  if (o.format !== undefined && o.format !== 'sweep.graph') throw new GraphParseError(`Unsupported format ${JSON.stringify(o.format)}; expected "sweep.graph".`);
  if (!Array.isArray(o.vertices) || !Array.isArray(o.edges)) throw new GraphParseError('A graph needs "vertices" and "edges" arrays.');
  const str = (x: unknown): string | undefined => (typeof x === 'string' ? x.slice(0, 200) : undefined);
  const graph: Graph = {
    format: 'sweep.graph',
    version: 1,
    vertices: o.vertices.map((v) => {
      const r = (v ?? {}) as Record<string, unknown>;
      const label = str(r.label);
      const geo = isPoint(r.geo) ? (r.geo as Point) : undefined;
      return { id: r.id as string, x: r.x as number, y: r.y as number, ...(label ? { label } : {}), ...(geo ? { geo } : {}) };
    }),
    edges: o.edges.map((e) => {
      const r = (e ?? {}) as Record<string, unknown>;
      const name = str(r.name);
      const shape = Array.isArray(r.shape) ? (r.shape as [number, number][]) : undefined;
      return {
        id: r.id as string,
        u: r.u as string,
        v: r.v as string,
        weight: r.weight as number,
        required: r.required === undefined ? true : (r.required as boolean),
        ...(name ? { name } : {}),
        ...(shape ? { shape } : {}),
        // `directed` is the legacy spelling of `oneway`.
        ...(r.oneway === true || r.directed === true ? { oneway: true } : {}),
        ...(typeof r.reverseWeight === 'number' ? { reverseWeight: r.reverseWeight } : {}),
        ...(str(r.sourceRef) ? { sourceRef: str(r.sourceRef) } : {}),
        ...(str(r.roadClass) ? { roadClass: str(r.roadClass) } : {}),
      };
    }),
  };
  const name = str(o.name);
  if (name) graph.name = name;
  const description = str(o.description);
  if (description) graph.description = description;
  const units = str(o.units);
  if (units) graph.units = units;
  if (typeof o.depotId === 'string') graph.depotId = o.depotId;
  const source = coerceProvenance(o.source);
  if (source) graph.source = source;
  const routing = coerceRouting(o.routing);
  if (routing) graph.routing = routing;
  return graph;
}

function isPoint(p: unknown): boolean {
  return Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && Number.isFinite(x));
}

const SOURCE_KINDS = new Set(['example', 'bundled-sample', 'imported-file', 'live-acquisition', 'user']);

function coerceProvenance(raw: unknown): DataProvenance | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== 'string' || !SOURCE_KINDS.has(r.kind)) return undefined;
  const text = (x: unknown, max = 300): string | undefined => (typeof x === 'string' ? x.slice(0, max) : undefined);
  const out: DataProvenance = { kind: r.kind as DataProvenance['kind'] };
  for (const k of ['provider', 'endpoint', 'retrievedAt', 'attribution', 'license'] as const) {
    const v = text(r[k]);
    if (v) out[k] = v;
  }
  if (Array.isArray(r.bbox) && r.bbox.length === 4 && r.bbox.every((x) => typeof x === 'number' && Number.isFinite(x))) out.bbox = r.bbox as [number, number, number, number];
  if (Array.isArray(r.roadClasses)) out.roadClasses = r.roadClasses.filter((x): x is string => typeof x === 'string').slice(0, 40).map((x) => x.slice(0, 40));
  if (Array.isArray(r.notes)) out.notes = r.notes.filter((x): x is string => typeof x === 'string').slice(0, 50).map((x) => x.slice(0, 500));
  if (typeof r.cached === 'boolean') out.cached = r.cached;
  return out;
}

function coerceRouting(raw: unknown): RoutingSettings | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: RoutingSettings = {};
  if (r.mode === 'undirected' || r.mode === 'directed') out.mode = r.mode;
  if (r.twoWay === 'both' || r.twoWay === 'either') out.twoWay = r.twoWay;
  if (typeof r.ignoreOneway === 'boolean') out.ignoreOneway = r.ignoreOneway;
  if (typeof r.vehicles === 'number' && Number.isInteger(r.vehicles)) out.vehicles = r.vehicles;
  if (r.objective === 'balance' || r.objective === 'total') out.objective = r.objective;
  if (r.maxRouteLength === null || (typeof r.maxRouteLength === 'number' && Number.isFinite(r.maxRouteLength))) out.maxRouteLength = r.maxRouteLength as number | null;
  return out;
}

function csvCell(value: string | number | boolean): string {
  const s = String(value);
  // Neutralise spreadsheet formula injection and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: (string | number | boolean)[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function routeToCsv(record: SingleRouteRecord, graph: Graph): string {
  const names = new Map(graph.edges.map((e) => [e.id, e.name ?? '']));
  return toCsv([
    ['step', 'edge_id', 'street_name', 'from', 'to', 'kind', 'length', 'cumulative'],
    ...record.route.steps.map((s) => [s.index + 1, s.edgeId, names.get(s.edgeId) ?? '', s.from, s.to, s.kind, s.weight, s.cumulative]),
  ]);
}

export function edgesToCsv(record: SingleRouteRecord, graph: Graph): string {
  // Records stored before directed mode existed have no `mode` and are undirected.
  const added = record.mode === 'directed' ? record.augmentation.addedEdgeCopies : record.augmentation.addedCopies;
  return toCsv([
    ['edge_id', 'street_name', 'u', 'v', 'length', 'oneway', 'required', 'traversals', 'added_copies'],
    ...graph.edges.map((e) => [e.id, e.name ?? '', e.u, e.v, e.weight, e.oneway === true || e.directed === true, e.required, record.route.traversalCounts[e.id] ?? 0, added[e.id] ?? 0]),
  ]);
}

/** One row per step of every vehicle route, plus each route's verification status. */
export function fleetToCsv(fleet: FleetRecord, graph: Graph): string {
  const names = new Map(graph.edges.map((e) => [e.id, e.name ?? '']));
  return toCsv([
    ['vehicle', 'step', 'edge_id', 'street_name', 'from', 'to', 'kind', 'length', 'cumulative', 'route_length', 'route_valid'],
    ...fleet.routes.flatMap((r) =>
      r.steps.map((s) => [r.vehicle, s.index + 1, s.edgeId, names.get(s.edgeId) ?? '', s.from, s.to, s.kind, s.weight, s.cumulative, r.distance, r.checks.every((c) => c.passed)]),
    ),
  ]);
}
