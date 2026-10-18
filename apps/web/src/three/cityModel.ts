import type { Graph, OptimizationRecord, Point } from '@sweep/engine';
import { mulberry32 } from '@sweep/engine/examples';
import { buildRouteGeometry, edgeDrawPoints, graphBounds, vertexMap, type RouteGeometry } from '../lib/geometry';

/**
 * Pure scene model derived from a graph (and optionally an optimisation
 * result). Everything the 3D views draw comes from here, so the 3D scene is
 * always a faithful rendering of the same data as the 2D canvas.
 * Coordinates: graph (x, y) → three (x, z), centred on the graph's bounds.
 */
export interface RoadSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  edgeId: string;
  required: boolean;
  traversals: number;
  repeated: boolean;
  deadhead: boolean;
}

export interface Building {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  rot: number;
  tone: number;
}

export interface CityModel {
  center: { x: number; z: number };
  extent: number;
  roads: RoadSegment[];
  vertices: Array<{ x: number; z: number; odd: boolean }>;
  buildings: Building[];
  route: RouteGeometry | null;
  depot: { x: number; z: number } | null;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function buildCityModel(graph: Graph, result: OptimizationRecord | null, opts: { seed?: number; maxBuildings?: number; roadClearance?: number } = {}): CityModel {
  const b = graphBounds(graph);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const extent = Math.max(b.maxX - b.minX, b.maxY - b.minY, 200);
  const vm = vertexMap(graph);
  const counts = result?.route.traversalCounts ?? {};
  const added = result?.augmentation.addedCopies ?? {};

  const roads: RoadSegment[] = [];
  const segs: Array<[number, number, number, number]> = [];
  for (const e of graph.edges) {
    const pts = edgeDrawPoints(e, vm);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const c = pts[i]!;
      segs.push([a[0], a[1], c[0], c[1]]);
      roads.push({
        ax: a[0] - cx,
        az: a[1] - cy,
        bx: c[0] - cx,
        bz: c[1] - cy,
        edgeId: e.id,
        required: e.required,
        traversals: counts[e.id] ?? 0,
        repeated: (added[e.id] ?? 0) > 0 && e.required,
        deadhead: (counts[e.id] ?? 0) > 0 && !e.required,
      });
    }
  }

  const deg = new Map<string, number>();
  for (const e of graph.edges) {
    if (!e.required) continue;
    deg.set(e.u, (deg.get(e.u) ?? 0) + 1);
    deg.set(e.v, (deg.get(e.v) ?? 0) + 1);
  }
  const vertices = graph.vertices.map((v) => ({ x: v.x - cx, z: v.y - cy, odd: (deg.get(v.id) ?? 0) % 2 === 1 }));

  // Buildings: sample a jittered grid; keep footprints clear of every road.
  const rnd = mulberry32(opts.seed ?? 1729);
  const clearance = opts.roadClearance ?? Math.max(14, extent * 0.012);
  const cell = Math.max(26, extent / 46);
  const cellSize = cell * 2;
  const grid = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const minX = Math.floor(Math.min(s[0], s[2]) / cellSize);
    const maxX = Math.floor(Math.max(s[0], s[2]) / cellSize);
    const minY = Math.floor(Math.min(s[1], s[3]) / cellSize);
    const maxY = Math.floor(Math.max(s[1], s[3]) / cellSize);
    for (let gx = minX; gx <= maxX; gx++) for (let gy = minY; gy <= maxY; gy++) {
      const k = `${gx},${gy}`;
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    }
  });
  const nearest = (x: number, y: number): number => {
    const gx = Math.floor(x / cellSize);
    const gy = Math.floor(y / cellSize);
    let best = Infinity;
    for (let ox = -2; ox <= 2; ox++) for (let oy = -2; oy <= 2; oy++) {
      for (const i of grid.get(`${gx + ox},${gy + oy}`) ?? []) {
        const s = segs[i]!;
        best = Math.min(best, distToSegment(x, y, s[0], s[1], s[2], s[3]));
      }
    }
    return best;
  };
  const buildings: Building[] = [];
  const pad = extent * 0.06;
  const maxB = opts.maxBuildings ?? 1400;
  for (let x = b.minX - pad; x <= b.maxX + pad && buildings.length < maxB; x += cell) {
    for (let y = b.minY - pad; y <= b.maxY + pad && buildings.length < maxB; y += cell) {
      const px = x + (rnd() - 0.5) * cell * 0.5;
      const py = y + (rnd() - 0.5) * cell * 0.5;
      const d = nearest(px, py);
      if (!Number.isFinite(d) || d > cell * 4) continue; // outside the urban fabric
      const room = d - clearance;
      if (room < cell * 0.22) continue;
      const size = Math.min(cell * 0.82, room * 1.25);
      const edgeFalloff = Math.min(1, d / (cell * 2.5));
      const tall = rnd() < 0.08;
      buildings.push({
        x: px - cx,
        z: py - cy,
        w: size * (0.62 + rnd() * 0.38),
        d: size * (0.62 + rnd() * 0.38),
        h: (tall ? 70 + rnd() * 110 : 12 + rnd() * 46) * (0.55 + edgeFalloff * 0.6) * (extent / 1200),
        rot: (rnd() - 0.5) * 0.18,
        tone: rnd(),
      });
    }
  }

  const route = result ? buildRouteGeometry(graph, result.route.steps) : null;
  const depotId = result?.input.depotId ?? graph.depotId ?? null;
  const dp = depotId ? vm.get(depotId) : undefined;
  return { center: { x: cx, z: cy }, extent, roads, vertices, buildings, route, depot: dp ? { x: dp.x - cx, z: dp.y - cy } : null };
}

/** Route polyline in scene coordinates (x, z) for drawing. */
export function routePoints3(model: CityModel): Point[] {
  if (!model.route) return [];
  return model.route.points.map((p) => [p[0] - model.center.x, p[1] - model.center.z] as Point);
}
