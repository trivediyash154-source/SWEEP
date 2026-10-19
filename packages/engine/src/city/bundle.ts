import type { Point } from '../types.js';
import { localProjection, bboxAreaKm2, type BBox } from '../geo.js';
import { osmToGraph, OSM_ATTRIBUTION, OSM_LICENSE, OSM_COPYRIGHT_URL, type OverpassElement } from '../osm.js';
import { buildingHeight, cleanRing, ringCentroid, type RingProblem } from './buildings.js';
import { HEIGHT_SOURCES, KEPT_WAY_TAGS, STOREY_HEIGHT_M, type CityBundle, type CityProvenance, type CityStats, type HeightSource, type TurnRestriction, type WayAttrs } from './types.js';

/** Overpass element including relation members and inline geometry (`out geom`). */
export interface OsmElement extends OverpassElement {
  members?: { type: string; ref: number; role: string }[];
  geometry?: { lat: number; lon: number }[];
}

export interface CityBuildInput {
  id: string;
  name: string;
  description: string;
  /** Acquisition region (south, west, north, east). */
  bbox: BBox;
  focus?: { lonlat: [number, number]; label: string };
  roadClasses: readonly string[];
  streets: OsmElement[];
  buildings: OsmElement[];
  restrictions?: OsmElement[];
  provenance: Omit<CityProvenance, 'source' | 'attribution' | 'license' | 'licenseUrl' | 'transformations' | 'estimates' | 'limitations' | 'builtAt' | 'bbox'> & {
    limitations?: string[];
  };
  builtAt?: string;
}

export interface CityBuildReport {
  notes: string[];
  stats: CityStats;
}

const dm = (m: number): number => Math.round(m * 10);
const e7 = (deg: number): number => Math.round(deg * 1e7);

/** Merge tile responses: one element per (type, id); the first occurrence wins. */
export function mergeElements(lists: readonly OsmElement[][]): { elements: OsmElement[]; duplicates: number } {
  const seen = new Set<string>();
  const out: OsmElement[] = [];
  let duplicates = 0;
  for (const list of lists) {
    for (const el of list) {
      const key = `${el.type}/${el.id}`;
      if (seen.has(key)) {
        duplicates++;
        continue;
      }
      seen.add(key);
      out.push(el);
    }
  }
  return { elements: out, duplicates };
}

/**
 * Build a city dataset from merged Overpass elements.
 *
 * Streets go through osmToGraph (rules documented in osm.ts: split at
 * intersections, duplicate and zero-length segments removed, one-way
 * semantics, largest connected network kept). Buildings are validated
 * footprints whose centroid lies inside the region; heights follow
 * buildings.ts. Turn restrictions are mapped when they use a via NODE that is
 * an intersection of the kept network; via-way restrictions are counted as
 * unsupported.
 */
export function buildCityBundle(input: CityBuildInput): { bundle: CityBundle; report: CityBuildReport } {
  const [s, w, n, e] = input.bbox;
  const origin: [number, number] = [Math.round(((w + e) / 2) * 1e7) / 1e7, Math.round(((s + n) / 2) * 1e7) / 1e7];
  const project = localProjection(origin[0], origin[1]);

  // ---- streets ------------------------------------------------------------------
  const conv = osmToGraph({ elements: input.streets }, {
    name: input.name,
    roadClasses: input.roadClasses,
    origin,
    limits: { maxWays: 200_000, maxVertices: 400_000, maxEdges: 800_000 },
  });
  const g = conv.graph;
  const wayTags = new Map<number, Record<string, string>>();
  for (const el of input.streets) if (el.type === 'way' && el.tags) wayTags.set(el.id, el.tags);

  const nodeIndex = new Map<string, number>();
  const nodeOsm: number[] = [];
  const nodeE7: number[] = [];
  const nodeDm: number[] = [];
  for (const v of g.vertices) {
    nodeIndex.set(v.id, nodeOsm.length);
    nodeOsm.push(Number(v.id.slice(1)));
    nodeE7.push(e7(v.geo![0]), e7(v.geo![1]));
    nodeDm.push(dm(v.x), dm(v.y));
  }
  const ways: WayAttrs[] = [];
  const wayIndex = new Map<number, number>();
  const segU: number[] = [];
  const segV: number[] = [];
  const segLenDm: number[] = [];
  const segWay: number[] = [];
  const segOneway: number[] = [];
  const segShapeOff: number[] = [0];
  const shapeDm: number[] = [];
  const roadClasses: Record<string, number> = {};
  let roadLength = 0;
  let onewaySegments = 0;
  /** (wayId, nodeIndex) → segment indices touching that node. */
  const segAtNode = new Map<string, number[]>();
  for (const ed of g.edges) {
    const wayId = Number(ed.sourceRef!.slice('osm:way/'.length));
    let wi = wayIndex.get(wayId);
    if (wi === undefined) {
      wi = ways.length;
      wayIndex.set(wayId, wi);
      const tags = wayTags.get(wayId) ?? {};
      const attrs: WayAttrs = { id: wayId, highway: tags.highway ?? ed.roadClass ?? 'road' };
      for (const k of KEPT_WAY_TAGS) {
        const val = tags[k];
        if (k !== 'highway' && typeof val === 'string' && val.length > 0) (attrs as unknown as Record<string, string>)[k] = val.slice(0, 120);
      }
      ways.push(attrs);
    }
    const si = segU.length;
    const u = nodeIndex.get(ed.u)!;
    const v = nodeIndex.get(ed.v)!;
    segU.push(u);
    segV.push(v);
    segLenDm.push(dm(ed.weight));
    segWay.push(wi);
    segOneway.push(ed.oneway ? 1 : 0);
    for (const p of ed.shape ?? []) shapeDm.push(dm(p[0]), dm(p[1]));
    segShapeOff.push(shapeDm.length / 2);
    roadLength += ed.weight;
    if (ed.oneway) onewaySegments++;
    const cls = ways[wi]!.highway;
    roadClasses[cls] = (roadClasses[cls] ?? 0) + 1;
    for (const node of [u, v]) {
      const key = `${wayId}:${node}`;
      const list = segAtNode.get(key);
      if (list) list.push(si);
      else segAtNode.set(key, [si]);
    }
  }

  // ---- turn restrictions ------------------------------------------------------
  const restrictions: TurnRestriction[] = [];
  let unsupported = 0;
  const unsupportedReasons: Record<string, number> = {};
  const skip = (why: string): void => {
    unsupported++;
    unsupportedReasons[why] = (unsupportedReasons[why] ?? 0) + 1;
  };
  for (const rel of input.restrictions ?? []) {
    if (rel.type !== 'relation') continue;
    const tags = rel.tags ?? {};
    if (tags.type !== 'restriction') continue;
    const value = tags.restriction;
    if (!value) {
      skip('conditional or vehicle-specific restriction tag only');
      continue;
    }
    const kind = value.startsWith('no_') ? 'no' : value.startsWith('only_') ? 'only' : null;
    if (!kind) {
      skip('unrecognised restriction value');
      continue;
    }
    const m = rel.members ?? [];
    const from = m.filter((x) => x.role === 'from' && x.type === 'way');
    const to = m.filter((x) => x.role === 'to' && x.type === 'way');
    const via = m.filter((x) => x.role === 'via');
    if (from.length !== 1 || to.length !== 1 || via.length !== 1) {
      skip('not exactly one from, via and to member');
      continue;
    }
    if (via[0]!.type !== 'node') {
      skip('via-way restriction');
      continue;
    }
    const viaIdx = nodeIndex.get(`n${via[0]!.ref}`);
    if (viaIdx === undefined) {
      skip('via node outside the kept network');
      continue;
    }
    const fs = segAtNode.get(`${from[0]!.ref}:${viaIdx}`) ?? [];
    const ts = segAtNode.get(`${to[0]!.ref}:${viaIdx}`) ?? [];
    if (fs.length !== 1 || ts.length !== 1) {
      skip(fs.length === 0 || ts.length === 0 ? 'from/to way not in the kept network at the via node' : 'from/to way passes through the via node (ambiguous direction)');
      continue;
    }
    restrictions.push({ osmId: rel.id, kind, value, fromSeg: fs[0]!, via: viaIdx, toSeg: ts[0]!, ...(tags.except ? { except: tags.except.slice(0, 80) } : {}) });
  }

  // ---- buildings ----------------------------------------------------------------
  const bOsm: number[] = [];
  const ringOff: number[] = [0];
  const ringDm: number[] = [];
  const heightDm: number[] = [];
  const heightSrc: number[] = [];
  const levelsOut: number[] = [];
  const kindIdx: number[] = [];
  const kinds: string[] = [];
  const kindMap = new Map<string, number>();
  const invalid: Partial<Record<RingProblem | 'missing-geometry', number>> = {};
  const bySource: Record<HeightSource, number> = { height: 0, levels: 0, estimate: 0 };
  let outside = 0;
  let bDup = 0;
  const seenB = new Set<number>();
  const pS = project([w, s]);
  const pN = project([e, n]);
  const minX = Math.min(pS[0], pN[0]);
  const maxX = Math.max(pS[0], pN[0]);
  const minY = Math.min(pS[1], pN[1]);
  const maxY = Math.max(pS[1], pN[1]);
  for (const el of input.buildings) {
    if (el.type !== 'way') continue;
    if (seenB.has(el.id)) {
      bDup++;
      continue;
    }
    seenB.add(el.id);
    const geom = el.geometry;
    if (!geom || geom.length === 0 || geom.some((p) => typeof p?.lat !== 'number' || typeof p?.lon !== 'number')) {
      invalid['missing-geometry'] = (invalid['missing-geometry'] ?? 0) + 1;
      continue;
    }
    const pts: Point[] = geom.map((p) => project([p.lon, p.lat]));
    const res = cleanRing(pts);
    if (!res.ok) {
      invalid[res.problem] = (invalid[res.problem] ?? 0) + 1;
      continue;
    }
    const c = ringCentroid(res.ring);
    if (c[0] < minX || c[0] > maxX || c[1] < minY || c[1] > maxY) {
      outside++;
      continue;
    }
    const tags = el.tags ?? {};
    const h = buildingHeight(tags, res.area);
    const kind = (tags.building ?? 'yes').slice(0, 40);
    let ki = kindMap.get(kind);
    if (ki === undefined) {
      ki = kinds.length;
      kinds.push(kind);
      kindMap.set(kind, ki);
    }
    bOsm.push(el.id);
    for (const p of res.ring) ringDm.push(dm(p[0]), dm(p[1]));
    ringOff.push(ringDm.length / 2);
    heightDm.push(dm(h.height));
    heightSrc.push(HEIGHT_SOURCES.indexOf(h.source));
    levelsOut.push(h.levels ?? -1);
    kindIdx.push(ki);
    bySource[h.source]++;
  }

  // ---- provenance, stats ----------------------------------------------------
  const areaKm2 = Math.round(bboxAreaKm2(input.bbox) * 100) / 100;
  const stats: CityStats = {
    areaKm2,
    nodes: nodeOsm.length,
    segments: segU.length,
    roadLengthKm: Math.round(roadLength / 10) / 100,
    onewaySegments,
    ways: ways.length,
    restrictions: { mapped: restrictions.length, unsupported },
    buildings: { total: bOsm.length, bySource, invalid: invalid as Record<string, number>, outsideRegion: outside, duplicates: bDup },
    roadClasses,
  };
  const transformations = [
    ...conv.notes,
    `Projected to a local equirectangular frame centred on ${origin[1].toFixed(5)}°N, ${origin[0].toFixed(5)}°E (x east, y south, metres); stored to 0.1 m.`,
    `Building footprints validated (closed, ≥ 3 distinct points, area ≥ 1 m², not self-intersecting); ${Object.values(invalid).reduce((a, b) => a + (b ?? 0), 0)} rejected; ${outside} with their centroid outside the region dropped; ${bDup} duplicates across tiles removed.`,
    `Turn restrictions: ${restrictions.length} mapped onto segments; ${unsupported} not supported${unsupported ? ` (${Object.entries(unsupportedReasons).map(([k, v]) => `${k}: ${v}`).join('; ')})` : ''}.`,
  ];
  const estimates = [
    `Building heights: ${bySource.height} from the OSM height tag, ${bySource.levels} from building:levels × ${STOREY_HEIGHT_M} m (storey height is an assumption), ${bySource.estimate} ESTIMATED for visual context only (no height or levels in OSM): levels from the building type where it implies one, otherwise from footprint area (< 40 m² → 1, < 120 → 2, < 400 → 3, < 1,200 → 4, else 5), × ${STOREY_HEIGHT_M} m. Estimated heights are not measurements.`,
  ];
  const provenance: CityProvenance = {
    source: 'OpenStreetMap',
    attribution: OSM_ATTRIBUTION,
    license: OSM_LICENSE,
    licenseUrl: OSM_COPYRIGHT_URL,
    endpoints: input.provenance.endpoints,
    bbox: input.bbox,
    osmBase: input.provenance.osmBase,
    fetched: input.provenance.fetched,
    builtAt: input.builtAt ?? new Date().toISOString(),
    tiles: input.provenance.tiles,
    queries: input.provenance.queries,
    transformations,
    estimates,
    limitations: [
      ...(input.provenance.tiles.missing.length ? [`${input.provenance.tiles.missing.length} tile(s) could not be downloaded; the area they cover is incomplete: ${input.provenance.tiles.missing.slice(0, 12).join(', ')}.`] : []),
      'Building multipolygon relations (courtyard buildings mapped as relations) are not included; simple building ways are.',
      'OpenStreetMap completeness varies; unmapped streets and buildings are absent, not "empty".',
      ...(input.provenance.limitations ?? []),
    ],
  };
  const bundle: CityBundle = {
    format: 'sweep-city/1',
    id: input.id,
    name: input.name,
    description: input.description,
    origin,
    ...(input.focus ? { focus: input.focus } : {}),
    provenance,
    stats,
    network: { nodeOsm, nodeE7, nodeDm, segU, segV, segLenDm, segWay, segOneway, segShapeOff, shapeDm, ways, restrictions },
    buildings: { osm: bOsm, ringOff, ringDm, heightDm, heightSrc, levels: levelsOut, kind: kindIdx, kinds },
  };
  return { bundle, report: { notes: transformations, stats } };
}
