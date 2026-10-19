import type { DataProvenance, Edge, Graph, Point, Vertex } from './types.js';
import { bboxAreaKm2, localProjection, polylineLength, type BBox } from './geo.js';

/**
 * OpenStreetMap (Overpass API JSON) → SWEEP graph conversion.
 *
 * Input: the JSON an Overpass API returns for `[out:json]` queries such as the
 * one built by buildOverpassQuery(): `elements` holding `node` elements
 * {id, lat, lon} and `way` elements {id, nodes: nodeId[], tags}.
 *
 * Conversion rules:
 *  1. Ways are included when tags.highway is one of the requested road classes
 *     (default DRIVABLE_ROAD_CLASSES). Ways tagged area=yes (pedestrian plazas
 *     mapped as areas) are rejected: their outline is not a street centreline.
 *  2. Ways that reference nodes missing from the response are skipped.
 *     Consecutive repeated node references are collapsed; ways that collapse
 *     to a single node are skipped.
 *  3. A node becomes a vertex (intersection) when it is the first or last node
 *     of an included way, or is referenced two or more times across all
 *     included ways (shared by two ways, or visited twice by one way).
 *     Vertex id "n<nodeId>", `geo` = [lon, lat].
 *  4. Each way is split at its vertices; each piece becomes one edge with id
 *     "w<wayId>-<k>" (k = 0, 1, … along the way), sourceRef "osm:way/<id>",
 *     name from tags.name (else tags.ref), roadClass = the highway value,
 *     required = true, weight = haversine length in metres rounded to 0.1 m,
 *     shape = the projected interior nodes. Pieces longer than 1,000 nodes are
 *     split further so that every shape stays small.
 *  5. One-way semantics (OSM conventions): oneway=yes|true|1 → one-way along the
 *     way; oneway=-1 → one-way against it (the piece is stored reversed:
 *     u and v swapped, shape reversed); junction=roundabout|circular and
 *     highway=motorway|motorway_link imply one-way unless oneway=no;
 *     oneway=reversible|alternating (direction changes over time) and
 *     unrecognised values are treated as two-way and reported in the notes.
 *  6. Zero-length pieces (distinct nodes at the identical position) are dropped
 *     and their end nodes merged into one vertex (the smaller node id), so the
 *     network stays connected.
 *  7. A piece that starts and ends at the same vertex (a closed way with no
 *     other junction, or a loop hanging off one junction) is split at its
 *     middle node, so map data never produces self-loops.
 *  8. Duplicate segments: pieces with identical node sequences (or exactly
 *     reversed ones) are one physical street; one is kept. A one-way piece is
 *     preferred over a two-way duplicate (the kept edge never permits travel
 *     the map forbids); two one-way duplicates in opposite directions become
 *     one two-way street; otherwise the lower way id wins.
 *  9. Connected components (ignoring direction): by default only the largest
 *     component by total length is kept and the dropped components are
 *     reported; `keepAllComponents` keeps everything.
 * 10. Planar x/y use the local equirectangular projection of geo.ts centred on
 *     the mean position of the kept vertices and shape points.
 * 11. Limits: more than 10,000 included ways, 20,000 vertices or 40,000 edges
 *     throw OsmImportError (code LIMIT_EXCEEDED); no usable street throws
 *     (code NO_ROADS).
 * 12. Output is deterministic: edges ordered by way id then piece index,
 *     vertices in order of first use, independent of the element order.
 *
 * The result carries `graph.source` (opts.source plus the conversion notes,
 * with OSM attribution and licence filled in when absent) and
 * `graph.routing` = { mode: 'directed' if any one-way edge else 'undirected', twoWay: 'both' }.
 */

/** Drivable street classes used by default (OSM highway=* values). */
export const DRIVABLE_ROAD_CLASSES: readonly string[] = [
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'pedestrian',
];

/** Every highway value SWEEP will put into an Overpass query (whitelist; anything else is rejected). */
export const KNOWN_ROAD_CLASSES: readonly string[] = [
  'motorway',
  'motorway_link',
  'trunk',
  'trunk_link',
  'primary',
  'primary_link',
  'secondary',
  'secondary_link',
  'tertiary',
  'tertiary_link',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'pedestrian',
  'road',
  'busway',
  'track',
  'footway',
  'cycleway',
  'path',
  'bridleway',
  'steps',
];

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const OSM_LICENSE = 'ODbL 1.0';
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
/** Default cap on the requested area, in km². */
export const MAX_BBOX_KM2 = 4;
/** Smallest accepted area, in km² (about 30 m × 30 m). */
export const MIN_BBOX_KM2 = 0.001;
export interface OsmLimits {
  maxWays: number;
  maxVertices: number;
  maxEdges: number;
}
export const OSM_LIMITS: Readonly<OsmLimits> = { maxWays: 10_000, maxVertices: 20_000, maxEdges: 40_000 };
const MAX_PIECE_NODES = 1000;
const MAX_NOTES = 50;

export type OsmImportErrorCode = 'INVALID_INPUT' | 'NO_ROADS' | 'LIMIT_EXCEEDED' | 'INVALID_QUERY';

export class OsmImportError extends Error {
  constructor(
    message: string,
    public code: OsmImportErrorCode = 'INVALID_INPUT',
  ) {
    super(message);
    this.name = 'OsmImportError';
  }
}

export interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  version?: number;
  generator?: string;
  osm3s?: { timestamp_osm_base?: string; copyright?: string };
  remark?: string;
  elements: OverpassElement[];
}

export interface OsmImportOptions {
  /** Graph name (default "OpenStreetMap streets"). */
  name?: string;
  /** Highway values to include (default DRIVABLE_ROAD_CLASSES). */
  roadClasses?: readonly string[];
  /** Keep every connected component instead of only the largest one. */
  keepAllComponents?: boolean;
  /** Provenance to store in graph.source; the conversion notes are appended. */
  source?: DataProvenance;
  /** Override the size limits (tests). */
  limits?: Partial<OsmLimits>;
}

export interface OsmImportStats {
  /** Ways converted (selected road classes, not areas, not skipped). */
  ways: number;
  /** Distinct OSM nodes referenced by the converted ways. */
  nodes: number;
  vertices: number;
  edges: number;
  onewayEdges: number;
  /** Pieces dropped because another piece covers the same node sequence. */
  duplicateSegments: number;
  droppedComponents: number;
  /** Total length of the dropped components, metres. */
  droppedLength: number;
  /** Total length of the kept edges, metres. */
  totalLength: number;
  /** Ways skipped for missing node references or degenerate geometry. */
  skippedWays: number;
}

export interface OsmImportResult {
  graph: Graph;
  stats: OsmImportStats;
  notes: string[];
  /** Count of every highway value seen among the input ways (before filtering). */
  roadClassesFound: Record<string, number>;
}

type Direction = 'two-way' | 'forward' | 'reverse';

interface WayIn {
  id: number;
  nodes: number[];
  tags: Record<string, string>;
  direction: Direction;
}

interface Piece {
  way: WayIn;
  k: number;
  /** Node ids in travel order (endpoints already merged); for two-way pieces, in way order. */
  seq: number[];
  /** Coordinates of seq. */
  coords: Point[];
  weight: number;
  oneway: boolean;
  dropped: boolean;
  /** Became two-way by merging opposite one-way duplicates. */
  merged?: boolean;
}

const isSafeId = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x);
const isLat = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 90;
const isLon = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 180;

function tagsOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  return out;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const km = (m: number): string => `${(m / 1000).toFixed(2)} km`;

/** Direction of travel for a way, following OSM tagging conventions (rule 5). */
function wayDirection(tags: Record<string, string>): { direction: Direction; flag?: 'reversible' | 'unknown' | 'implied' } {
  const raw = tags.oneway;
  const ow = raw?.trim().toLowerCase();
  if (ow === 'yes' || ow === 'true' || ow === '1') return { direction: 'forward' };
  if (ow === '-1') return { direction: 'reverse' };
  if (ow === 'no' || ow === 'false' || ow === '0') return { direction: 'two-way' };
  if (ow === 'reversible' || ow === 'alternating') return { direction: 'two-way', flag: 'reversible' };
  const junction = tags.junction;
  const implied = junction === 'roundabout' || junction === 'circular' || tags.highway === 'motorway' || tags.highway === 'motorway_link';
  if (implied) return { direction: 'forward', flag: 'implied' };
  return ow === undefined ? { direction: 'two-way' } : { direction: 'two-way', flag: 'unknown' };
}

/** Dedupe road classes and order them canonically (KNOWN_ROAD_CLASSES order). Throws on values outside the whitelist. */
export function normalizeRoadClasses(classes: readonly string[]): string[] {
  const known = new Set(KNOWN_ROAD_CLASSES);
  const bad = classes.filter((c) => !known.has(c));
  if (bad.length) throw new OsmImportError(`Unknown road class ${bad.map((b) => JSON.stringify(String(b).slice(0, 40))).join(', ')}. Allowed: ${KNOWN_ROAD_CLASSES.join(', ')}.`, 'INVALID_QUERY');
  if (classes.length === 0) throw new OsmImportError('Choose at least one road class.', 'INVALID_QUERY');
  const set = new Set(classes);
  return KNOWN_ROAD_CLASSES.filter((c) => set.has(c));
}

/** Shape, range and ordering problems of a bbox (no area checks). */
function bboxShapeProblems(bbox: unknown): string[] {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    return ['The area must be four numbers: south, west, north, east (decimal degrees).'];
  }
  const [s, w, n, e] = bbox as BBox;
  const problems: string[] = [];
  if (Math.abs(s) > 90 || Math.abs(n) > 90) problems.push('Latitudes (south and north) must be between −90 and 90.');
  if (Math.abs(w) > 180 || Math.abs(e) > 180) problems.push('Longitudes (west and east) must be between −180 and 180.');
  if (s >= n) problems.push(`South (${s}) must be less than north (${n}).`);
  if (w >= e) problems.push(`West (${w}) must be less than east (${e}). Areas crossing the 180° meridian are not supported.`);
  return problems;
}

/**
 * Human-readable problems with a bounding box [south, west, north, east] in
 * degrees; an empty list means it is acceptable. Checks shape, ranges,
 * ordering (areas crossing the antimeridian are not supported) and the area
 * (at most maxKm2, at least MIN_BBOX_KM2).
 */
export function validateBbox(bbox: unknown, maxKm2: number = MAX_BBOX_KM2): string[] {
  const problems = bboxShapeProblems(bbox);
  if (problems.length === 0) {
    const area = bboxAreaKm2(bbox as BBox);
    if (area > maxKm2) problems.push(`The area is ${area.toFixed(2)} km²; the limit is ${maxKm2} km². Choose a smaller district.`);
    else if (area < MIN_BBOX_KM2) problems.push(`The area is too small (${Math.round(area * 1e6)} m²). Make each side at least about 30 m.`);
  }
  return problems;
}

function fmtCoord(x: number): string {
  const s = x.toFixed(7).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * Overpass QL for every way with one of the given highway values inside the
 * bbox, plus the nodes they use. Only whitelisted highway values
 * (KNOWN_ROAD_CLASSES) are accepted, so user input can never alter the query
 * structure. The bbox must be well-formed (ranges and ordering); callers
 * enforce the area limits with validateBbox. Classes keep the given order (deduped).
 */
export function buildOverpassQuery(bbox: readonly [number, number, number, number], roadClasses: readonly string[] = DRIVABLE_ROAD_CLASSES, timeoutSeconds = 25): string {
  const problems = bboxShapeProblems([...bbox]);
  if (problems.length) throw new OsmImportError(problems.join(' '), 'INVALID_QUERY');
  normalizeRoadClasses(roadClasses);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 180) throw new OsmImportError('The query timeout must be 1–180 seconds.', 'INVALID_QUERY');
  const classes = [...new Set(roadClasses)];
  const [s, w, n, e] = bbox;
  return `[out:json][timeout:${timeoutSeconds}];way["highway"~"^(${classes.join('|')})$"](${fmtCoord(s)},${fmtCoord(w)},${fmtCoord(n)},${fmtCoord(e)});(._;>;);out body;`;
}

/**
 * Directed reachability check: counts the edges (and vertices) outside the
 * largest strongly connected component when one-way edges are arcs u→v and
 * two-way edges are arcs in both directions (iterative Kosaraju).
 */
function edgesOutsideMainStrongComponent(vertices: readonly Vertex[], edges: readonly Edge[]): { edges: number; vertices: number } {
  const index = new Map(vertices.map((v, i) => [v.id, i]));
  const n = vertices.length;
  const fwd: number[][] = Array.from({ length: n }, () => []);
  const bwd: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    const u = index.get(e.u)!;
    const v = index.get(e.v)!;
    fwd[u]!.push(v);
    bwd[v]!.push(u);
    if (!e.oneway) {
      fwd[v]!.push(u);
      bwd[u]!.push(v);
    }
  }
  const order: number[] = [];
  const seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    seen[s] = 1;
    const stack: Array<[number, number]> = [[s, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const next = fwd[top[0]]![top[1]++];
      if (next === undefined) {
        order.push(top[0]);
        stack.pop();
      } else if (!seen[next]) {
        seen[next] = 1;
        stack.push([next, 0]);
      }
    }
  }
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const s = order[i]!;
    if (comp[s] !== -1) continue;
    const c = sizes.length;
    sizes.push(0);
    comp[s] = c;
    const stack = [s];
    while (stack.length) {
      const x = stack.pop()!;
      sizes[c]!++;
      for (const y of bwd[x]!) if (comp[y] === -1) {
        comp[y] = c;
        stack.push(y);
      }
    }
  }
  let main = 0;
  for (let c = 1; c < sizes.length; c++) if (sizes[c]! > sizes[main]!) main = c;
  let outEdges = 0;
  for (const e of edges) if (comp[index.get(e.u)!] !== main || comp[index.get(e.v)!] !== main) outEdges++;
  return { edges: outEdges, vertices: n - (sizes[main] ?? 0) };
}

/** Convert Overpass API JSON into a SWEEP graph (rules in the module comment). */
export function osmToGraph(input: unknown, opts: OsmImportOptions = {}): OsmImportResult {
  if (typeof input !== 'object' || input === null || !Array.isArray((input as { elements?: unknown }).elements)) {
    throw new OsmImportError('Expected Overpass API JSON (an object with an "elements" array, from an [out:json] query).', 'INVALID_INPUT');
  }
  const elements = (input as { elements: unknown[] }).elements;
  const limits = { ...OSM_LIMITS, ...(opts.limits ?? {}) };
  const classList = [...new Set(opts.roadClasses ?? DRIVABLE_ROAD_CLASSES)];
  const classSet = new Set(classList);

  // ---- 1. read nodes and ways ------------------------------------------------
  const coords = new Map<number, Point>();
  const waysById = new Map<number, { id: number; nodes: unknown[]; tags: Record<string, string> }>();
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    const e = el as Record<string, unknown>;
    if (e.type === 'node') {
      if (isSafeId(e.id) && isLat(e.lat) && isLon(e.lon)) coords.set(e.id, [e.lon, e.lat]);
    } else if (e.type === 'way') {
      if (isSafeId(e.id) && Array.isArray(e.nodes) && !waysById.has(e.id)) waysById.set(e.id, { id: e.id, nodes: e.nodes, tags: tagsOf(e.tags) });
    }
  }
  const allWays = [...waysById.values()].sort((a, b) => a.id - b.id);

  const roadClassesFound: Record<string, number> = {};
  const excluded = new Map<string, number>();
  let areaWays = 0;
  let missingWays = 0;
  let degenerateWays = 0;
  let reversibleWays = 0;
  let impliedWays = 0;
  const unknownOneway = new Map<string, number>();
  const included: WayIn[] = [];
  for (const w of allWays) {
    const hw = w.tags.highway;
    if (!hw) continue;
    roadClassesFound[hw] = (roadClassesFound[hw] ?? 0) + 1;
    if (!classSet.has(hw)) {
      excluded.set(hw, (excluded.get(hw) ?? 0) + 1);
      continue;
    }
    if (w.tags.area === 'yes') {
      areaWays++;
      continue;
    }
    if (!w.nodes.every((id) => isSafeId(id) && coords.has(id))) {
      missingWays++;
      continue;
    }
    const seq: number[] = [];
    for (const id of w.nodes as number[]) if (seq[seq.length - 1] !== id) seq.push(id);
    if (seq.length < 2) {
      degenerateWays++;
      continue;
    }
    const { direction, flag } = wayDirection(w.tags);
    if (flag === 'reversible') reversibleWays++;
    else if (flag === 'implied') impliedWays++;
    else if (flag === 'unknown') {
      const v = (w.tags.oneway ?? '').slice(0, 30);
      unknownOneway.set(v, (unknownOneway.get(v) ?? 0) + 1);
    }
    included.push({ id: w.id, nodes: seq, tags: w.tags, direction });
  }
  if (included.length > limits.maxWays) {
    throw new OsmImportError(`The area contains ${included.length.toLocaleString('en-US')} streets; the limit is ${limits.maxWays.toLocaleString('en-US')}. Choose a smaller area.`, 'LIMIT_EXCEEDED');
  }
  if (included.length === 0) {
    const found = Object.keys(roadClassesFound).length ? ` Found only: ${Object.entries(roadClassesFound).map(([k, n]) => `${k} (${n})`).join(', ')}.` : '';
    throw new OsmImportError(`No usable streets of the selected road classes were found in this data.${found}`, 'NO_ROADS');
  }

  // ---- 2. vertices: endpoints and nodes referenced twice or more --------------
  const occurrences = new Map<number, number>();
  for (const w of included) for (const id of w.nodes) occurrences.set(id, (occurrences.get(id) ?? 0) + 1);

  // ---- 3. split ways into raw pieces -----------------------------------------
  const raw: { way: WayIn; nodes: number[] }[] = [];
  for (const w of included) {
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      const isVertex = i === w.nodes.length - 1 || (occurrences.get(w.nodes[i]!) ?? 0) >= 2 || i - start >= MAX_PIECE_NODES - 1;
      if (!isVertex) continue;
      raw.push({ way: w, nodes: w.nodes.slice(start, i + 1) });
      start = i;
    }
  }

  // ---- 4. zero-length pieces: drop and merge their end nodes ----------------
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const coordsOf = (ids: readonly number[]): Point[] => ids.map((id) => coords.get(id)!);
  let zeroLength = 0;
  const nonZero: { way: WayIn; nodes: number[]; length: number }[] = [];
  for (const p of raw) {
    const length = polylineLength(coordsOf(p.nodes));
    if (length > 0) {
      nonZero.push({ ...p, length });
      continue;
    }
    zeroLength++;
    const a = find(p.nodes[0]!);
    const b = find(p.nodes[p.nodes.length - 1]!);
    if (a !== b) {
      parent.set(Math.max(a, b), Math.min(a, b));
      parent.set(Math.min(a, b), Math.min(a, b));
    }
  }

  // ---- 5. split loops at their middle node; orient one-way pieces -----------
  let loopsSplit = 0;
  let droppedLoops = 0;
  const pieces: Piece[] = [];
  const counters = new Map<number, number>();
  const pushPiece = (way: WayIn, nodes: number[]): void => {
    const c = coordsOf(nodes);
    const length = polylineLength(c);
    if (!(length > 0)) {
      zeroLength++;
      return;
    }
    const seq = [find(nodes[0]!), ...nodes.slice(1, -1), find(nodes[nodes.length - 1]!)];
    const reverse = way.direction === 'reverse';
    if (reverse) {
      seq.reverse();
      c.reverse();
    }
    const k = counters.get(way.id) ?? 0;
    counters.set(way.id, k + 1);
    pieces.push({ way, k, seq, coords: c, weight: Math.round(length * 10) / 10, oneway: way.direction !== 'two-way', dropped: false });
  };
  for (const p of nonZero) {
    const a = find(p.nodes[0]!);
    const b = find(p.nodes[p.nodes.length - 1]!);
    if (a !== b) {
      pushPiece(p.way, p.nodes);
      continue;
    }
    if (p.nodes.length < 3) {
      droppedLoops++;
      continue;
    }
    loopsSplit++;
    const mid = Math.floor(p.nodes.length / 2);
    pushPiece(p.way, p.nodes.slice(0, mid + 1));
    pushPiece(p.way, p.nodes.slice(mid));
  }

  // ---- 6. duplicate segments --------------------------------------------------
  let duplicates = 0;
  let mergedOpposite = 0;
  const byKey = new Map<string, Piece>();
  for (const p of pieces) {
    const fwd = p.seq.join(',');
    const rev = [...p.seq].reverse().join(',');
    const key = fwd < rev ? fwd : rev;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, p);
      continue;
    }
    duplicates++;
    if (existing.oneway && p.oneway) {
      if (existing.seq.join(',') !== fwd) {
        existing.oneway = false;
        existing.merged = true;
        mergedOpposite++;
      }
      p.dropped = true;
    } else if (p.oneway && !existing.oneway && !existing.merged) {
      existing.dropped = true;
      byKey.set(key, p);
    } else p.dropped = true;
  }
  let kept = pieces.filter((p) => !p.dropped);

  // ---- 7. connected components (undirected) ---------------------------------
  const comp = new Map<number, number>();
  const findC = (x: number): number => {
    let r = x;
    while (comp.has(r) && comp.get(r) !== r) r = comp.get(r)!;
    let c = x;
    while (c !== r) {
      const next = comp.get(c)!;
      comp.set(c, r);
      c = next;
    }
    return r;
  };
  for (const p of kept) {
    const a = findC(p.seq[0]!);
    const b = findC(p.seq[p.seq.length - 1]!);
    comp.set(a, a);
    if (a !== b) comp.set(b, a);
  }
  const compStats = new Map<number, { length: number; first: number }>();
  kept.forEach((p, i) => {
    const r = findC(p.seq[0]!);
    const s = compStats.get(r);
    if (s) s.length += p.weight;
    else compStats.set(r, { length: p.weight, first: i });
  });
  let droppedComponents = 0;
  let droppedLength = 0;
  if (!opts.keepAllComponents && compStats.size > 1) {
    let best: [number, { length: number; first: number }] | null = null;
    for (const entry of compStats) {
      if (!best || entry[1].length > best[1].length + 1e-9 || (Math.abs(entry[1].length - best[1].length) <= 1e-9 && entry[1].first < best[1].first)) best = entry;
    }
    const mainRoot = best![0];
    for (const [r, s] of compStats) {
      if (r === mainRoot) continue;
      droppedComponents++;
      droppedLength += s.length;
    }
    kept = kept.filter((p) => findC(p.seq[0]!) === mainRoot);
  }
  if (kept.length === 0) throw new OsmImportError('No usable street segments remained after cleaning the data (all were zero-length or degenerate).', 'NO_ROADS');

  // ---- 8. build the graph -----------------------------------------------------
  const vertexOrder: number[] = [];
  const seenVertex = new Set<number>();
  for (const p of kept) {
    for (const id of [p.seq[0]!, p.seq[p.seq.length - 1]!]) {
      if (!seenVertex.has(id)) {
        seenVertex.add(id);
        vertexOrder.push(id);
      }
    }
  }
  if (vertexOrder.length > limits.maxVertices) {
    throw new OsmImportError(`The area produces ${vertexOrder.length.toLocaleString('en-US')} intersections; the limit is ${limits.maxVertices.toLocaleString('en-US')}. Choose a smaller area.`, 'LIMIT_EXCEEDED');
  }
  if (kept.length > limits.maxEdges) {
    throw new OsmImportError(`The area produces ${kept.length.toLocaleString('en-US')} street segments; the limit is ${limits.maxEdges.toLocaleString('en-US')}. Choose a smaller area.`, 'LIMIT_EXCEEDED');
  }

  let sumLon = 0;
  let sumLat = 0;
  let cnt = 0;
  const addMean = (p: Point): void => {
    sumLon += p[0];
    sumLat += p[1];
    cnt++;
  };
  for (const id of vertexOrder) addMean(coords.get(id)!);
  for (const p of kept) for (const c of p.coords.slice(1, -1)) addMean(c);
  const project = localProjection(sumLon / cnt, sumLat / cnt);

  const vertices: Vertex[] = vertexOrder.map((id) => {
    const g = coords.get(id)!;
    const [x, y] = project(g);
    return { id: `n${id}`, x, y, geo: [g[0], g[1]] };
  });
  let onewayEdges = 0;
  let totalLength = 0;
  const onewayWays = new Set<number>();
  const edges: Edge[] = kept.map((p) => {
    const name = (p.way.tags.name ?? p.way.tags.ref)?.trim().slice(0, 120);
    const shape = p.coords.slice(1, -1).map(project);
    if (p.oneway) {
      onewayEdges++;
      onewayWays.add(p.way.id);
    }
    totalLength += p.weight;
    return {
      id: `w${p.way.id}-${p.k}`,
      u: `n${p.seq[0]}`,
      v: `n${p.seq[p.seq.length - 1]}`,
      weight: p.weight,
      required: true,
      ...(name ? { name } : {}),
      ...(shape.length ? { shape } : {}),
      ...(p.oneway ? { oneway: true } : {}),
      sourceRef: `osm:way/${p.way.id}`,
      roadClass: p.way.tags.highway!.slice(0, 40),
    };
  });
  totalLength = Math.round(totalLength * 10) / 10;
  droppedLength = Math.round(droppedLength * 10) / 10;
  const usedNodes = new Set<number>();
  for (const w of included) for (const id of w.nodes) usedNodes.add(id);

  // ---- 9. notes -----------------------------------------------------------------
  const notes: string[] = [];
  notes.push(`Converted ${plural(included.length, 'OpenStreetMap way')} into ${plural(vertices.length, 'intersection')} and ${plural(edges.length, 'street segment')} (${km(totalLength)}).`);
  if (excluded.size) notes.push(`Ignored ${plural([...excluded.values()].reduce((a, b) => a + b, 0), 'way')} of other road classes: ${[...excluded.entries()].map(([k, n]) => `${k} (${n})`).join(', ')}.`);
  if (areaWays) notes.push(`Rejected ${plural(areaWays, 'way')} tagged area=yes (squares and plazas mapped as areas; their outline is not a street centreline).`);
  if (missingWays) notes.push(`Skipped ${plural(missingWays, 'way')} referencing nodes missing from the response.`);
  if (degenerateWays) notes.push(`Skipped ${plural(degenerateWays, 'way')} with fewer than two distinct nodes.`);
  if (onewayEdges) {
    notes.push(
      `${plural(onewayEdges, 'one-way street segment')} (from ${plural(onewayWays.size, 'way')}) may only be driven in the mapped direction${impliedWays ? `; ${plural(impliedWays, 'way')} one-way by implication (roundabout or motorway)` : ''}. Routing defaults to directed mode.`,
    );
  } else notes.push('No one-way streets in this area: every street is two-way.');
  if (mergedOpposite) notes.push(`${plural(mergedOpposite, 'pair')} of opposite one-way ways on the same nodes became two-way streets.`);
  if (reversibleWays) notes.push(`${plural(reversibleWays, 'way')} tagged oneway=reversible/alternating (direction changes over time) treated as two-way.`);
  if (unknownOneway.size) notes.push(`Unrecognised oneway value(s) ${[...unknownOneway.entries()].map(([v, n]) => `"${v}" (${n})`).join(', ')} treated as two-way.`);
  if (duplicates) notes.push(`Removed ${plural(duplicates, 'duplicate segment')} (identical node sequences in several ways).`);
  if (zeroLength) notes.push(`Dropped ${plural(zeroLength, 'zero-length segment')} (distinct nodes at the same position were merged).`);
  if (loopsSplit) notes.push(`Split ${plural(loopsSplit, 'closed loop')} at the middle node so that no street starts and ends at the same intersection.`);
  if (droppedLoops) notes.push(`Dropped ${plural(droppedLoops, 'degenerate loop')}.`);
  if (droppedComponents) notes.push(`Dropped ${plural(droppedComponents, 'disconnected piece')} of network (${km(droppedLength)}); kept the largest connected network.`);
  else if (opts.keepAllComponents && compStats.size > 1) notes.push(`The network has ${compStats.size} disconnected parts; all were kept.`);
  if (onewayEdges && compStats.size - droppedComponents === 1) {
    const outside = edgesOutsideMainStrongComponent(vertices, edges);
    if (outside.edges > 0) {
      notes.push(
        `Respecting one-way rules, ${plural(outside.edges, 'street segment')} (${plural(outside.vertices, 'intersection')}) cannot be driven as part of a closed route from the main network, usually because a one-way street leaves the selected area. Enlarge the area or treat one-way streets as two-way to cover them.`,
      );
    }
  }

  const stats: OsmImportStats = {
    ways: included.length,
    nodes: usedNodes.size,
    vertices: vertices.length,
    edges: edges.length,
    onewayEdges,
    duplicateSegments: duplicates,
    droppedComponents,
    droppedLength,
    totalLength,
    skippedWays: missingWays + degenerateWays,
  };

  const base: DataProvenance = opts.source ?? { kind: 'imported-file', provider: 'OpenStreetMap (Overpass JSON)' };
  const source: DataProvenance = {
    ...base,
    attribution: base.attribution ?? OSM_ATTRIBUTION,
    license: base.license ?? OSM_LICENSE,
    roadClasses: base.roadClasses ?? classList,
    notes: [...(base.notes ?? []), ...notes].slice(0, MAX_NOTES).map((n) => n.slice(0, 500)),
  };
  const classesText = (source.roadClasses ?? classList).join(', ');
  const graph: Graph = {
    format: 'sweep.graph',
    version: 1,
    name: (opts.name ?? 'OpenStreetMap streets').slice(0, 120),
    description: `Street network from OpenStreetMap (highway: ${classesText}). ${OSM_ATTRIBUTION}, ${OSM_LICENSE}.`.slice(0, 500),
    units: 'm',
    vertices,
    edges,
    source,
    routing: { mode: onewayEdges > 0 ? 'directed' : 'undirected', twoWay: 'both' },
  };
  return { graph, stats, notes, roadClassesFound };
}
