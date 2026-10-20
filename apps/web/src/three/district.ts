import type { Graph } from '@sweep/engine';
import { isOneway } from '@sweep/engine';
import { mulberry32 } from '@sweep/engine/examples';
import { edgeDrawPoints, graphBounds, vertexMap } from '../lib/geometry';

/**
 * Procedural district generated deterministically from a street graph.
 *
 * The graph is the source of truth: every road, junction, marking and arrow
 * below is derived from its vertices and edges; buildings and trees are
 * procedural massing placed in the space between streets (they are context,
 * not map data). Coordinates: graph (x, y) → scene (x, z), centred.
 */
export interface RoadSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  edgeId: string;
  required: boolean;
  oneway: boolean;
}

export interface Mark {
  x: number;
  z: number;
  rot: number;
  len: number;
}

export interface Junction {
  id: string;
  x: number;
  z: number;
  degree: number;
}

/** One instanced part of a building (box, cylinder or gable roof). */
export interface Part {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  rot: number;
  tone: number;
}

export interface Tree {
  x: number;
  z: number;
  s: number;
  tone: number;
}

export interface District {
  center: { x: number; z: number };
  extent: number;
  roadW: number;
  laneW: number;
  roads: RoadSeg[];
  dashes: Mark[];
  arrows: Mark[];
  junctions: Junction[];
  boxes: Part[];
  cylinders: Part[];
  gables: Part[];
  trees: Tree[];
  vertexPos: Map<string, { x: number; z: number }>;
  style: 'modern' | 'historic';
}

function distToSegment(px: number, py: number, s: [number, number, number, number]): { d: number; ang: number } {
  const dx = s[2] - s[0];
  const dy = s[3] - s[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - s[0]) * dx + (py - s[1]) * dy) / len2));
  return { d: Math.hypot(px - (s[0] + t * dx), py - (s[1] + t * dy)), ang: Math.atan2(dy, dx) };
}

export function buildDistrict(graph: Graph, opts: { seed?: number; maxBuildings?: number } = {}): District {
  const b = graphBounds(graph);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const extent = Math.max(b.maxX - b.minX, b.maxY - b.minY, 200);
  const vm = vertexMap(graph);
  const realMap = !!graph.source && (graph.source.kind === 'bundled-sample' || graph.source.kind === 'live-acquisition' || graph.source.kind === 'imported-file');
  const style: District['style'] = realMap ? 'historic' : 'modern';
  const roadW = Math.max(5, Math.min(26, extent * 0.0105));
  const laneW = roadW * 0.26;

  const roads: RoadSeg[] = [];
  const segs: Array<[number, number, number, number]> = [];
  const dashes: Mark[] = [];
  const arrows: Mark[] = [];
  for (const e of graph.edges) {
    const pts = edgeDrawPoints(e, vm);
    const ow = isOneway(e);
    let along = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const c = pts[i]!;
      segs.push([a[0], a[1], c[0], c[1]]);
      roads.push({ ax: a[0] - cx, az: a[1] - cy, bx: c[0] - cx, bz: c[1] - cy, edgeId: e.id, required: e.required, oneway: ow });
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const rot = Math.atan2(c[1] - a[1], c[0] - a[0]);
      // Lane markings: dashed centre line on two-way streets, direction arrows on one-way streets.
      const spacing = ow ? roadW * 4.2 : roadW * 1.6;
      let t = (spacing - (along % spacing)) % spacing;
      for (; t < len; t += spacing) {
        const x = a[0] + ((c[0] - a[0]) * t) / len - cx;
        const z = a[1] + ((c[1] - a[1]) * t) / len - cy;
        if (ow) arrows.push({ x, z, rot, len: roadW * 0.9 });
        else if (e.required) dashes.push({ x, z, rot, len: roadW * 0.7 });
      }
      along += len;
    }
  }

  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.u, (degree.get(e.u) ?? 0) + 1);
    degree.set(e.v, (degree.get(e.v) ?? 0) + 1);
  }
  const vertexPos = new Map<string, { x: number; z: number }>();
  const junctions: Junction[] = graph.vertices.map((v) => {
    vertexPos.set(v.id, { x: v.x - cx, z: v.y - cy });
    return { id: v.id, x: v.x - cx, z: v.y - cy, degree: degree.get(v.id) ?? 0 };
  });

  // ---- spatial index of road segments --------------------------------------
  const cell = Math.max(roadW * 2.6, extent / 52);
  const gsz = cell * 2;
  const grid = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const x0 = Math.floor(Math.min(s[0], s[2]) / gsz);
    const x1 = Math.floor(Math.max(s[0], s[2]) / gsz);
    const y0 = Math.floor(Math.min(s[1], s[3]) / gsz);
    const y1 = Math.floor(Math.max(s[1], s[3]) / gsz);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const k = `${gx},${gy}`;
      const l = grid.get(k);
      if (l) l.push(i);
      else grid.set(k, [i]);
    }
  });
  const nearest = (x: number, y: number): { d: number; ang: number } => {
    const gx = Math.floor(x / gsz);
    const gy = Math.floor(y / gsz);
    let best = { d: Infinity, ang: 0 };
    for (let ox = -2; ox <= 2; ox++) for (let oy = -2; oy <= 2; oy++) {
      for (const i of grid.get(`${gx + ox},${gy + oy}`) ?? []) {
        const r = distToSegment(x, y, segs[i]!);
        if (r.d < best.d) best = r;
      }
    }
    return best;
  };

  // Network "centre of gravity" drives the skyline: taller near the middle.
  let mx = 0;
  let my = 0;
  for (const v of graph.vertices) {
    mx += v.x;
    my += v.y;
  }
  mx /= Math.max(1, graph.vertices.length);
  my /= Math.max(1, graph.vertices.length);

  const rnd = mulberry32(opts.seed ?? 1729 + graph.vertices.length * 31 + graph.edges.length);
  const boxes: Part[] = [];
  const cylinders: Part[] = [];
  const gables: Part[] = [];
  const trees: Tree[] = [];
  const occupied = new Set<string>();
  const clearance = roadW * 0.5 + roadW * 0.55; // half road + sidewalk + setback
  const pad = extent * 0.07;
  const maxB = opts.maxBuildings ?? 1500;
  const hScale = style === 'historic' ? Math.max(9, extent * 0.018) : Math.max(14, extent * 0.03);
  let count = 0;

  for (let x = b.minX - pad; x <= b.maxX + pad && count < maxB; x += cell) {
    for (let y = b.minY - pad; y <= b.maxY + pad && count < maxB; y += cell) {
      const px = x + (rnd() - 0.5) * cell * 0.35;
      const py = y + (rnd() - 0.5) * cell * 0.35;
      const near = nearest(px, py);
      if (!Number.isFinite(near.d) || near.d > cell * 3.2) continue;
      const room = near.d - clearance;
      if (room < cell * 0.18) {
        // Too tight for a building: a street tree on the verge.
        if (room > -roadW * 0.15 && near.d > roadW * 0.75 && rnd() < 0.55) trees.push({ x: px - cx, z: py - cy, s: roadW * (0.55 + rnd() * 0.35), tone: rnd() });
        continue;
      }
      const centrality = Math.exp(-((px - mx) ** 2 + (py - my) ** 2) / (2 * (extent * 0.32) ** 2));
      const parkChance = style === 'historic' ? 0.05 : 0.08;
      if (rnd() < parkChance * (1.2 - centrality)) {
        for (let t = 0; t < 3; t++) trees.push({ x: px - cx + (rnd() - 0.5) * cell * 0.7, z: py - cy + (rnd() - 0.5) * cell * 0.7, s: roadW * (0.7 + rnd() * 0.5), tone: rnd() });
        continue;
      }
      const size = Math.min(cell * 0.92, room * 1.5);
      const w = size * (0.7 + rnd() * 0.3);
      const d = size * (0.6 + rnd() * 0.4);
      const rot = -near.ang + (rnd() - 0.5) * 0.05;
      const tone = rnd();
      const sx = px - cx;
      const sz = py - cy;
      occupied.add(`${Math.round(x / cell)},${Math.round(y / cell)}`);
      count++;
      const noise = 0.6 + rnd() * 0.8;
      const h = hScale * (0.45 + 1.7 * centrality) * noise;
      const r = rnd();
      if (style === 'historic') {
        // Old-town fabric: 3–6 storey blocks with gabled roofs, occasional flat roof and tower.
        const body = Math.max(hScale * 0.5, h * 0.9);
        boxes.push({ x: sx, y: 0, z: sz, w, h: body, d, rot, tone });
        if (r < 0.78) gables.push({ x: sx, y: body, z: sz, w: w * 1.02, h: Math.min(w, d) * (0.42 + rnd() * 0.2), d: d * 1.02, rot, tone });
        else if (r < 0.86 && centrality > 0.45) cylinders.push({ x: sx, y: body, z: sz, w: Math.min(w, d) * 0.28, h: body * 0.9, d: 0, rot: 0, tone });
        else boxes.push({ x: sx + (rnd() - 0.5) * w * 0.3, y: body, z: sz + (rnd() - 0.5) * d * 0.3, w: w * 0.22, h: hScale * 0.12, d: d * 0.22, rot, tone: 0.5 });
        continue;
      }
      if (h < hScale * 0.7) {
        // Low-rise: gabled house or flat roof with plant.
        boxes.push({ x: sx, y: 0, z: sz, w, h, d, rot, tone });
        if (r < 0.5) gables.push({ x: sx, y: h, z: sz, w: w * 1.03, h: Math.min(w, d) * 0.45, d: d * 1.03, rot, tone });
        else boxes.push({ x: sx + w * 0.15, y: h, z: sz - d * 0.1, w: w * 0.3, h: h * 0.14, d: d * 0.28, rot, tone: 0.5 });
      } else if (h < hScale * 1.6 || r < 0.35) {
        // Mid-rise slab with a setback top, or an L-shaped block.
        if (r < 0.55) {
          const lower = h * (0.62 + rnd() * 0.12);
          boxes.push({ x: sx, y: 0, z: sz, w, h: lower, d, rot, tone });
          boxes.push({ x: sx, y: lower, z: sz, w: w * 0.72, h: h - lower, d: d * 0.7, rot, tone });
        } else {
          boxes.push({ x: sx, y: 0, z: sz, w, h, d: d * 0.45, rot, tone });
          const c = Math.cos(-rot);
          const s = Math.sin(-rot);
          const ox = -w * 0.28;
          const oz = d * 0.25;
          boxes.push({ x: sx + ox * c - oz * s, y: 0, z: sz + ox * s + oz * c, w: w * 0.44, h: h * 0.82, d: d * 0.55, rot, tone });
        }
      } else if (r < 0.62) {
        // Podium and tower with a crown.
        const pod = h * 0.16;
        boxes.push({ x: sx, y: 0, z: sz, w, h: pod, d, rot, tone });
        const tw = w * (0.52 + rnd() * 0.16);
        const td = d * (0.52 + rnd() * 0.16);
        boxes.push({ x: sx, y: pod, z: sz, w: tw, h: h - pod, d: td, rot, tone });
        boxes.push({ x: sx, y: h, z: sz, w: tw * 0.6, h: h * 0.05, d: td * 0.6, rot, tone: 0.5 });
      } else {
        // Round tower on a podium.
        const pod = h * 0.12;
        boxes.push({ x: sx, y: 0, z: sz, w, h: pod, d, rot, tone });
        cylinders.push({ x: sx, y: pod, z: sz, w: Math.min(w, d) * 0.36, h: h - pod, d: 0, rot: 0, tone });
      }
    }
  }
  return { center: { x: cx, z: cy }, extent, roadW, laneW, roads, dashes, arrows, junctions, boxes, cylinders, gables, trees: trees.slice(0, 1200), vertexPos, style };
}
