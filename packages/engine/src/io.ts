import type { Graph, OptimizationRecord } from './types.js';

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
      return { id: r.id as string, x: r.x as number, y: r.y as number, ...(label ? { label } : {}) };
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
        ...(r.directed === true ? { directed: true } : {}),
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
  return graph;
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

export function routeToCsv(record: OptimizationRecord, graph: Graph): string {
  const names = new Map(graph.edges.map((e) => [e.id, e.name ?? '']));
  return toCsv([
    ['step', 'edge_id', 'street_name', 'from', 'to', 'kind', 'length', 'cumulative'],
    ...record.route.steps.map((s) => [s.index + 1, s.edgeId, names.get(s.edgeId) ?? '', s.from, s.to, s.kind, s.weight, s.cumulative]),
  ]);
}

export function edgesToCsv(record: OptimizationRecord, graph: Graph): string {
  return toCsv([
    ['edge_id', 'street_name', 'u', 'v', 'length', 'required', 'traversals', 'added_copies'],
    ...graph.edges.map((e) => [e.id, e.name ?? '', e.u, e.v, e.weight, e.required, record.route.traversalCounts[e.id] ?? 0, record.augmentation.addedCopies[e.id] ?? 0]),
  ]);
}
