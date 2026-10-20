import type { Edge, Graph, Point, Vertex } from '../types.js';
import type { CityModel } from '../city/types.js';
import { UnionFind } from '../graph.js';
import { findUnserviceableStreets } from '../directed.js';

/**
 * Service zones and the coverage graph of a zone.
 *
 * A zone selects the road segments a service plan must cover. The coverage
 * graph contains the WHOLE connected city network: segments in the zone are
 * required, every other segment stays available as an optional (deadhead)
 * street, so a vehicle may leave the zone to turn around or to follow a
 * one-way street back in. Edge ids are `s<segment index>`, vertex ids
 * `n<OSM node id>`, so every edge traces back to the physical road segment
 * and its OSM way (`sourceRef`).
 */

export type Zone =
  | { kind: 'rect'; minX: number; minY: number; maxX: number; maxY: number }
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'polygon'; points: Point[] };

/** How a scenario overrides a segment's direction: 'forward' = one-way u→v, 'reverse' = one-way v→u, 'two-way'. */
export type ZoneOnewayOverride = 'forward' | 'reverse' | 'two-way';

export interface ZoneOptions {
  zone: Zone;
  /** Road classes (OSM highway values) to service; default: every class. */
  roadClasses?: readonly string[];
  direction: 'undirected' | 'directed';
  /** Segments closed to traffic (removed from the network). */
  closedSegments?: Iterable<number>;
  onewayOverrides?: ReadonlyMap<number, ZoneOnewayOverride>;
  costModel?: 'distance';
  /** Depot vertex id; in directed mode the report then lists required segments no legal closed route from it can service. */
  depotId?: string;
}

export interface ZoneReport {
  requiredSegments: number;
  requiredKm: number;
  optionalSegments: number;
  optionalKm: number;
  closedSegments: number;
  /** Required segments dropped because closures cut them off from the main network. */
  cutOffSegments: number[];
  onewayRequired: number;
  zoneAreaKm2: number;
  /** Directed mode with a depot: required edge ids that cannot be entered from / cannot return to the depot legally. */
  unserviceable?: { unreachable: string[]; noReturn: string[] };
}

export interface ZoneGraph {
  graph: Graph;
  report: ZoneReport;
  /** Segment index of every edge (edge order). */
  edgeSegment: Int32Array;
  /** City node index of every vertex (vertex order). */
  vertexNode: Int32Array;
}

export function pointInZone(zone: Zone, x: number, y: number): boolean {
  switch (zone.kind) {
    case 'rect':
      return x >= zone.minX && x <= zone.maxX && y >= zone.minY && y <= zone.maxY;
    case 'circle':
      return (x - zone.cx) ** 2 + (y - zone.cy) ** 2 <= zone.r * zone.r;
    case 'polygon': {
      const p = zone.points;
      let inside = false;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const [xi, yi] = p[i]!;
        const [xj, yj] = p[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
  }
}

export function zoneAreaM2(zone: Zone): number {
  switch (zone.kind) {
    case 'rect':
      return Math.max(0, zone.maxX - zone.minX) * Math.max(0, zone.maxY - zone.minY);
    case 'circle':
      return Math.PI * zone.r * zone.r;
    case 'polygon': {
      let a = 0;
      const p = zone.points;
      for (let i = 0; i < p.length; i++) {
        const q = p[(i + 1) % p.length]!;
        a += p[i]![0] * q[1] - q[0] * p[i]![1];
      }
      return Math.abs(a) / 2;
    }
  }
}

/** Point halfway along a segment's polyline (by length). */
export function segmentMidpoint(city: CityModel, s: number): Point {
  const a = city.segPtOff[s]!;
  const b = city.segPtOff[s + 1]!;
  let total = 0;
  for (let p = a; p < b - 1; p++) total += Math.hypot(city.segXY[2 * p + 2]! - city.segXY[2 * p]!, city.segXY[2 * p + 3]! - city.segXY[2 * p + 1]!);
  let half = total / 2;
  for (let p = a; p < b - 1; p++) {
    const x0 = city.segXY[2 * p]!;
    const y0 = city.segXY[2 * p + 1]!;
    const x1 = city.segXY[2 * p + 2]!;
    const y1 = city.segXY[2 * p + 3]!;
    const l = Math.hypot(x1 - x0, y1 - y0);
    if (half <= l || p === b - 2) {
      const f = l > 0 ? Math.min(1, half / l) : 0;
      return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f];
    }
    half -= l;
  }
  return [city.segXY[2 * a]!, city.segXY[2 * a + 1]!];
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Build the coverage graph of a zone (see the module note). */
export function zoneCoverageGraph(city: CityModel, opts: ZoneOptions): ZoneGraph {
  const classes = opts.roadClasses ? new Set(opts.roadClasses) : null;
  const closed = new Set(opts.closedSegments ?? []);
  const overrides = opts.onewayOverrides ?? new Map<number, ZoneOnewayOverride>();

  // Union-find over open segments to find the connected network.
  const uf = new UnionFind(city.nodeCount);
  for (let s = 0; s < city.segCount; s++) if (!closed.has(s)) uf.union(city.segU[s]!, city.segV[s]!);
  const inZone = new Uint8Array(city.segCount);
  const reqLenByRoot = new Map<number, number>();
  for (let s = 0; s < city.segCount; s++) {
    if (closed.has(s)) continue;
    const cls = city.ways[city.segWay[s]!]!.highway;
    if (classes && !classes.has(cls)) continue;
    const [mx, my] = segmentMidpoint(city, s);
    if (!pointInZone(opts.zone, mx, my)) continue;
    inZone[s] = 1;
    const r = uf.find(city.segU[s]!);
    reqLenByRoot.set(r, (reqLenByRoot.get(r) ?? 0) + city.segLen[s]!);
  }
  // Keep the network component holding most required length; required segments elsewhere were cut off by closures.
  let root = -1;
  let best = -1;
  for (const [r, len] of reqLenByRoot) if (len > best || (len === best && r < root)) [root, best] = [r, len];
  if (root < 0 && city.nodeCount > 0) {
    // No required segment: keep the largest open component so the graph is still usable.
    const size = new Map<number, number>();
    for (let s = 0; s < city.segCount; s++) if (!closed.has(s)) size.set(uf.find(city.segU[s]!), (size.get(uf.find(city.segU[s]!)) ?? 0) + 1);
    for (const [r, c] of size) if (c > best) [root, best] = [r, c];
  }

  const vertexOf = new Int32Array(city.nodeCount).fill(-1);
  const vertices: Vertex[] = [];
  const vertexNode: number[] = [];
  const addVertex = (node: number): string => {
    if (vertexOf[node]! < 0) {
      vertexOf[node] = vertices.length;
      vertexNode.push(node);
      vertices.push({ id: `n${city.nodeOsm[node]}`, x: round1(city.nodeX[node]!), y: round1(city.nodeY[node]!), geo: [city.nodeLon[node]!, city.nodeLat[node]!] });
    }
    return vertices[vertexOf[node]!]!.id;
  };
  const edges: Edge[] = [];
  const edgeSegment: number[] = [];
  const cutOff: number[] = [];
  let reqLen = 0;
  let optLen = 0;
  let onewayRequired = 0;
  for (let s = 0; s < city.segCount; s++) {
    if (closed.has(s)) continue;
    if (uf.find(city.segU[s]!) !== root) {
      if (inZone[s]) cutOff.push(s);
      continue;
    }
    const w = city.ways[city.segWay[s]!]!;
    let u = city.segU[s]!;
    let v = city.segV[s]!;
    const a = city.segPtOff[s]!;
    const b = city.segPtOff[s + 1]!;
    let shape: Point[] = [];
    for (let p = a + 1; p < b - 1; p++) shape.push([round1(city.segXY[2 * p]!), round1(city.segXY[2 * p + 1]!)]);
    let oneway = city.segOneway[s] === 1;
    const ov = overrides.get(s);
    if (ov === 'two-way') oneway = false;
    else if (ov === 'forward') oneway = true;
    else if (ov === 'reverse') {
      oneway = true;
      [u, v] = [v, u];
      shape = shape.reverse();
    }
    const required = inZone[s] === 1;
    const len = city.segLen[s]!;
    if (required) {
      reqLen += len;
      if (oneway) onewayRequired++;
    } else optLen += len;
    edges.push({
      id: `s${s}`,
      u: addVertex(u),
      v: addVertex(v),
      weight: len,
      required,
      ...(w.name ? { name: w.name } : w.ref ? { name: w.ref } : {}),
      ...(shape.length ? { shape } : {}),
      ...(oneway ? { oneway: true } : {}),
      sourceRef: `osm:way/${w.id}`,
      roadClass: w.highway,
    });
    edgeSegment.push(s);
  }
  const graph: Graph = {
    format: 'sweep.graph',
    version: 1,
    name: `${city.name}: service zone`,
    description: `Coverage graph of a service zone in ${city.name}. Required: segments whose midpoint lies in the zone${classes ? ` (classes: ${[...classes].join(', ')})` : ''}; every other connected segment is available for deadheading. ${city.provenance.attribution}, ${city.provenance.license}.`.slice(0, 500),
    units: 'm',
    vertices,
    edges,
    source: { kind: 'bundled-sample', provider: `OpenStreetMap (${city.name})`, attribution: city.provenance.attribution, license: city.provenance.license, bbox: city.provenance.bbox },
    routing: { mode: opts.direction, twoWay: 'both' },
  };
  const unserviceable =
    opts.direction === 'directed' && opts.depotId && vertices.some((v) => v.id === opts.depotId) && edges.some((e) => e.required) ? findUnserviceableStreets(graph, opts.depotId) : undefined;
  return {
    graph,
    report: {
      ...(unserviceable ? { unserviceable } : {}),
      requiredSegments: edges.filter((e) => e.required).length,
      requiredKm: Math.round(reqLen) / 1000,
      optionalSegments: edges.filter((e) => !e.required).length,
      optionalKm: Math.round(optLen) / 1000,
      closedSegments: closed.size,
      cutOffSegments: cutOff,
      onewayRequired,
      zoneAreaKm2: Math.round(zoneAreaM2(opts.zone) / 1e4) / 100,
    },
    edgeSegment: Int32Array.from(edgeSegment),
    vertexNode: Int32Array.from(vertexNode),
  };
}

/** City node nearest to a point (linear scan; adequate for interactive use). */
export function nearestNode(city: CityModel, x: number, y: number): number {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < city.nodeCount; i++) {
    const d = (city.nodeX[i]! - x) ** 2 + (city.nodeY[i]! - y) ** 2;
    if (d < bd) [best, bd] = [i, d];
  }
  return best;
}
