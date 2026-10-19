import type { Graph, Point, RouteStep } from '@sweep/engine';
import { edgeDrawPoints, polylineLength, vertexMap, pointAlong } from './geometry';

/**
 * Drawable geometry of an ordered route, parameterised by TRUE route distance
 * (the engine's cumulative weights), so every animation, readout and shader
 * uses the same authoritative numbers. Each traversal is drawn on its own
 * lane: offset to the right of the direction of travel, one lane further out
 * for every earlier pass over the same street. Repeated traversals and the two
 * directions of a two-way street therefore appear as parallel strands instead
 * of disappearing under each other.
 */
export interface RouteTrack {
  steps: RouteStep[];
  /** Lane-offset polyline per step, in travel direction. */
  stepPoints: Point[][];
  /** Drawn length of each step polyline. */
  stepDrawn: number[];
  /** True distance at the start of each step (length steps + 1). */
  cumDist: number[];
  total: number;
  /** Pass number of each step over its street (0 = first traversal). */
  pass: number[];
  /** Concatenated polyline and the true distance reached at each of its points. */
  points: Point[];
  pointDist: number[];
  /** Drawn (screen-space) length reached at each point of `points`. */
  pointDrawn: number[];
  totalDrawn: number;
}

function offsetPolyline(pts: Point[], d: number): Point[] {
  if (d === 0 || pts.length < 2) return pts;
  const out: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]!;
    const b = pts[Math.min(pts.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    // Right-hand normal in map coordinates (y points down the screen / south).
    out.push([pts[i]![0] - (dy / len) * d, pts[i]![1] + (dx / len) * d]);
  }
  return out;
}

export function buildTrack(graph: Graph, steps: RouteStep[], opts: { laneWidth?: number } = {}): RouteTrack {
  const vm = vertexMap(graph);
  const edges = new Map(graph.edges.map((e) => [e.id, e]));
  const lane = opts.laneWidth ?? 0;
  const passes = new Map<string, number>();
  const stepPoints: Point[][] = [];
  const stepDrawn: number[] = [];
  const cumDist: number[] = [0];
  const pass: number[] = [];
  const points: Point[] = [];
  const pointDist: number[] = [];
  const pointDrawn: number[] = [];
  let drawnRun = 0;
  for (const st of steps) {
    const e = edges.get(st.edgeId);
    let pts = e ? edgeDrawPoints(e, vm) : [];
    if (e && st.from !== e.u) pts = [...pts].reverse();
    const p = passes.get(st.edgeId) ?? 0;
    passes.set(st.edgeId, p + 1);
    pass.push(p);
    if (lane > 0) pts = offsetPolyline(pts, lane * (0.55 + p * 0.95));
    stepPoints.push(pts);
    const drawn = polylineLength(pts);
    stepDrawn.push(drawn);
    const d0 = cumDist[cumDist.length - 1]!;
    let run = 0;
    pts.forEach((pt, i) => {
      if (i > 0) run += Math.hypot(pt[0] - pts[i - 1]![0], pt[1] - pts[i - 1]![1]);
      else if (points.length > 0) drawnRun += Math.hypot(pt[0] - points[points.length - 1]![0], pt[1] - points[points.length - 1]![1]);
      points.push(pt);
      pointDist.push(d0 + (drawn > 0 ? (run / drawn) * st.weight : i === 0 ? 0 : st.weight));
      pointDrawn.push(drawnRun + run);
    });
    drawnRun += drawn;
    cumDist.push(d0 + st.weight);
  }
  return { steps, stepPoints, stepDrawn, cumDist, total: cumDist[cumDist.length - 1]!, pass, points, pointDist, pointDrawn, totalDrawn: drawnRun };
}

/** Drawn length along `points` reached after travelling true distance `d`. */
export function drawnAtDistance(track: RouteTrack, d: number): number {
  const D = track.pointDist;
  if (D.length === 0) return 0;
  if (d <= 0) return 0;
  if (d >= track.total) return track.totalDrawn;
  let lo = 0;
  let hi = D.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (D[mid]! <= d) lo = mid;
    else hi = mid - 1;
  }
  const next = Math.min(D.length - 1, lo + 1);
  const span = D[next]! - D[lo]!;
  const f = span > 0 ? (d - D[lo]!) / span : 0;
  return track.pointDrawn[lo]! + (track.pointDrawn[next]! - track.pointDrawn[lo]!) * f;
}

export interface TrackSample {
  point: Point;
  angle: number;
  stepIndex: number;
  distance: number;
}

/** Position and heading after travelling `d` (true distance) along the route. */
export function sampleTrack(track: RouteTrack, d: number): TrackSample {
  const n = track.steps.length;
  if (n === 0) return { point: [0, 0], angle: 0, stepIndex: 0, distance: 0 };
  const dist = Math.max(0, Math.min(track.total, d));
  // Last step that starts at or before `dist`.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (track.cumDist[mid]! <= dist) lo = mid;
    else hi = mid - 1;
  }
  const w = track.steps[lo]!.weight;
  const frac = w > 0 ? Math.min(1, (dist - track.cumDist[lo]!) / w) : 1;
  const { point, angle } = pointAlong(track.stepPoints[lo]!, frac * track.stepDrawn[lo]!);
  return { point, angle, stepIndex: lo, distance: dist };
}

/** Bounding box of a set of points. */
export function pointsBounds(pts: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}
