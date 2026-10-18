import type { Edge, Graph, Point, RouteStep } from '@sweep/engine';

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function graphBounds(graph: Graph): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const v of graph.vertices) add(v.x, v.y);
  for (const e of graph.edges) for (const p of e.shape ?? []) add(p[0], p[1]);
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  if (maxX - minX < 1) {
    minX -= 200;
    maxX += 200;
  }
  if (maxY - minY < 1) {
    minY -= 150;
    maxY += 150;
  }
  return { minX, minY, maxX, maxY };
}

export type VertexMap = Map<string, { x: number; y: number }>;

export function vertexMap(graph: Graph): VertexMap {
  return new Map(graph.vertices.map((v) => [v.id, { x: v.x, y: v.y }]));
}

export function edgePoints(edge: Edge, vm: VertexMap): Point[] {
  const a = vm.get(edge.u);
  const b = vm.get(edge.v);
  if (!a || !b) return [];
  if (edge.u === edge.v && !(edge.shape && edge.shape.length)) {
    // self-loop without a shape: draw a small teardrop
    const r = 28;
    return [
      [a.x, a.y],
      [a.x + r, a.y - r * 0.6],
      [a.x + r * 0.9, a.y - r * 1.5],
      [a.x, a.y - r * 1.8],
      [a.x - r * 0.9, a.y - r * 1.5],
      [a.x - r, a.y - r * 0.6],
      [a.x, a.y],
    ];
  }
  return [[a.x, a.y], ...(edge.shape ?? []), [b.x, b.y]];
}

/** Smooth a polyline through its interior points (Catmull–Rom) into a dense polyline. */
export function densify(points: Point[], perSegment = 10): Point[] {
  if (points.length <= 2) return points;
  const out: Point[] = [points[0]!];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    for (let s = 1; s <= perSegment; s++) {
      const t = s / perSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  return out;
}

/** Drawn geometry of an edge: smoothed when it has interior shape points. */
export function edgeDrawPoints(edge: Edge, vm: VertexMap): Point[] {
  return densify(edgePoints(edge, vm));
}

export function polylinePath(points: Point[]): string {
  if (points.length === 0) return '';
  let d = `M${points[0]![0].toFixed(1)},${points[0]![1].toFixed(1)}`;
  for (let i = 1; i < points.length; i++) d += `L${points[i]![0].toFixed(1)},${points[i]![1].toFixed(1)}`;
  return d;
}

export function pointsToPath(points: Point[]): string {
  if (points.length === 0) return '';
  if (points.length === 2) return `M${points[0]![0]},${points[0]![1]}L${points[1]![0]},${points[1]![1]}`;
  // Smooth curve through interior points (Catmull–Rom → Bézier) for curved streets.
  let d = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0]},${p2[1]}`;
  }
  return d;
}

export function polylineLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  return len;
}

export function midpoint(points: Point[]): Point {
  const total = polylineLength(points);
  return pointAlong(points, total / 2).point;
}

/** Point and heading at arc length `s` along a polyline. */
export function pointAlong(points: Point[], s: number): { point: Point; angle: number } {
  if (points.length === 0) return { point: [0, 0], angle: 0 };
  if (points.length === 1) return { point: points[0]!, angle: 0 };
  let remaining = Math.max(0, s);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining <= seg || i === points.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, remaining / seg);
      return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
    }
    remaining -= seg;
  }
  const a = points[points.length - 2]!;
  const b = points[points.length - 1]!;
  return { point: b, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

/**
 * Ordered geometry for an optimised route. Animation advances by drawn length
 * (constant visual speed); the distance readout maps each step's drawn
 * fraction onto its true weight, so displayed distances match the engine.
 */
export interface RouteGeometry {
  points: Point[];
  /** cumulative drawn length at each step start (length = steps + 1) */
  stepStart: number[];
  totalDrawn: number;
  steps: RouteStep[];
  stepPoints: Point[][];
}

export function buildRouteGeometry(graph: Graph, steps: RouteStep[]): RouteGeometry {
  const vm = vertexMap(graph);
  const edges = new Map(graph.edges.map((e) => [e.id, e]));
  const points: Point[] = [];
  const stepStart: number[] = [0];
  const stepPoints: Point[][] = [];
  let total = 0;
  for (const st of steps) {
    const e = edges.get(st.edgeId);
    let pts = e ? edgeDrawPoints(e, vm) : [];
    if (e && st.from !== e.u) pts = [...pts].reverse();
    stepPoints.push(pts);
    const len = polylineLength(pts);
    for (let i = points.length === 0 ? 0 : 1; i < pts.length; i++) points.push(pts[i]!);
    total += len;
    stepStart.push(total);
  }
  return { points, stepStart, totalDrawn: total, steps, stepPoints };
}

export interface RouteSample {
  point: Point;
  angle: number;
  stepIndex: number;
  distance: number;
}

/** Sample the route at drawn-length progress `s` ∈ [0, totalDrawn]. */
export function sampleRoute(geo: RouteGeometry, s: number): RouteSample {
  const steps = geo.steps;
  if (steps.length === 0) return { point: [0, 0], angle: 0, stepIndex: 0, distance: 0 };
  const clamped = Math.max(0, Math.min(geo.totalDrawn, s));
  let lo = 0;
  let hi = steps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (geo.stepStart[mid + 1]! < clamped) lo = mid + 1;
    else hi = mid;
  }
  const i = lo;
  const segLen = geo.stepStart[i + 1]! - geo.stepStart[i]!;
  const local = clamped - geo.stepStart[i]!;
  const frac = segLen > 0 ? local / segLen : 1;
  const { point, angle } = pointAlong(geo.stepPoints[i]!, local);
  const prevCum = i === 0 ? 0 : steps[i - 1]!.cumulative;
  return { point, angle, stepIndex: i, distance: prevCum + frac * steps[i]!.weight };
}
