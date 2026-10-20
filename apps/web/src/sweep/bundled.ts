import { zoneCoverageGraph, type CityModel, type Graph } from '@sweep/engine';

/**
 * The bundled real OpenStreetMap extract (Pune: Bibwewadi and VIT) as a street graph for the sweep planner, so a zone
 * inside it plans at once, with no live download. The extract is partial, so a zone is served from it only when its
 * download box lies inside the extract and touches none of the street tiles that are missing from it.
 */

type BBox = [number, number, number, number]; // south, west, north, east

export interface BundledCoverage {
  /** The extract's bounding box. */
  bbox: BBox;
  /** Street tiles listed as missing in the bundle's provenance. */
  missing: BBox[];
}

/** The extract's box and its missing street tiles, from the bundle's provenance. */
export function bundledCoverage(city: CityModel): BundledCoverage {
  const p = city.provenance as unknown as { bbox: BBox; tiles?: { missing?: string[] } };
  const missing: BBox[] = [];
  for (const m of p.tiles?.missing ?? []) {
    const hit = /streets \(([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+)\)/.exec(m);
    if (hit) missing.push([Number(hit[1]), Number(hit[2]), Number(hit[3]), Number(hit[4])]);
  }
  return { bbox: p.bbox, missing };
}

const overlaps = (a: BBox, b: BBox): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** Whether every street of `box` is in the extract: inside its box and clear of every missing street tile. */
export function coversBox(cov: BundledCoverage, box: BBox): boolean {
  const [s, w, n, e] = cov.bbox;
  const inside = box[0] >= s && box[1] >= w && box[2] <= n && box[3] <= e;
  return inside && !cov.missing.some((t) => overlaps(t, box));
}

/**
 * The extract's streets of the given road classes as one connected graph (its largest component), with the same ids,
 * WGS84 positions, shapes, one-way flags and OSM references the coverage engine uses. Which streets are required is
 * left to the planner (`zoneGraph` marks the streets of the zone).
 */
export function bundledStreetGraph(city: CityModel, roadClasses: readonly string[]): Graph {
  const all = zoneCoverageGraph(city, { zone: { kind: 'rect', minX: -1e9, minY: -1e9, maxX: 1e9, maxY: 1e9 }, direction: 'directed', roadClasses }).graph;
  const keep = new Set(roadClasses);
  const edges = all.edges.filter((e) => e.roadClass !== undefined && keep.has(e.roadClass));
  // Largest connected component of the kept streets.
  const index = new Map(all.vertices.map((v, i) => [v.id, i]));
  const parent = all.vertices.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  for (const e of edges) parent[find(index.get(e.u)!)] = find(index.get(e.v)!);
  const length = new Map<number, number>();
  for (const e of edges) length.set(find(index.get(e.u)!), (length.get(find(index.get(e.u)!)) ?? 0) + e.weight);
  let root = -1;
  let best = -1;
  for (const [r, len] of length) if (len > best) [root, best] = [r, len];
  const used = new Set<string>();
  const kept = edges.filter((e) => find(index.get(e.u)!) === root);
  for (const e of kept) used.add(e.u).add(e.v);
  return {
    ...all,
    name: `${city.name}: bundled streets`,
    vertices: all.vertices.filter((v) => used.has(v.id)),
    edges: kept.map((e) => ({ ...e, required: false })),
  };
}
