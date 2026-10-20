import { zoneAreaM2, type Zone } from '@sweep/engine';

/**
 * Drawing service zones on the map: rectangle (two corners), circle (centre,
 * then a point on the rim) and polygon (vertices, then finish). The zone these
 * helpers produce is passed to the engine unchanged; the outline is only for
 * display (a circle is drawn as a 96-gon, but the engine tests the true circle).
 */

export type ZoneShape = Zone['kind'];
export type XY = [number, number];

/** Smallest zones accepted: a rectangle side or circle radius of 10 m, a polygon of 100 m². */
export const MIN_SIDE_M = 10;
export const MIN_POLYGON_M2 = 100;

/** Orientation of the triangle a, b, c: > 0 counter-clockwise, < 0 clockwise, 0 collinear. */
function orient(a: XY, b: XY, c: XY): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: XY, b: XY, p: XY): boolean {
  return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
}

/** True when segments ab and cd share at least one point (touching and collinear overlap count). */
export function segmentsIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d)) || (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b));
}

/** Whether appending p to an open polyline keeps it simple (the new edge meets no earlier edge except at the shared vertex). */
export function canExtend(points: readonly XY[], p: XY): boolean {
  const n = points.length;
  if (n === 0) return true;
  const last = points[n - 1]!;
  if (last[0] === p[0] && last[1] === p[1]) return false;
  // The edge just before the new one shares `last`; it may only meet the new edge there.
  if (n >= 2) {
    const prev = points[n - 2]!;
    if (orient(prev, last, p) === 0 && (onSegment(prev, last, p) || onSegment(last, p, prev))) return false;
  }
  for (let i = 0; i + 1 < n - 1; i++) if (segmentsIntersect(points[i]!, points[i + 1]!, last, p)) return false;
  return true;
}

/** Whether a closed polygon is simple: no two non-adjacent edges meet. */
export function isSimplePolygon(points: readonly XY[]): boolean {
  const n = points.length;
  if (n < 3) return false;
  const edge = (i: number): [XY, XY] => [points[i]!, points[(i + 1) % n]!];
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // the closing edge and the first edge share the first point
      const [a, b] = edge(i);
      const [c, d] = edge(j);
      if (segmentsIntersect(a, b, c, d)) return false;
    }
  }
  return true;
}

/** Whether the closing edge (last → first) keeps the polygon simple. */
export function canClose(points: readonly XY[]): boolean {
  const n = points.length;
  if (n < 3) return false;
  const first = points[0]!;
  const last = points[n - 1]!;
  for (let i = 1; i + 1 < n - 1; i++) if (segmentsIntersect(points[i]!, points[i + 1]!, last, first)) return false;
  return true;
}

export function rectZone(a: XY, b: XY): Extract<Zone, { kind: 'rect' }> {
  return { kind: 'rect', minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) };
}

export function circleZone(centre: XY, rim: XY): Extract<Zone, { kind: 'circle' }> {
  return { kind: 'circle', cx: centre[0], cy: centre[1], r: Math.hypot(rim[0] - centre[0], rim[1] - centre[1]) };
}

export function polygonZone(points: readonly XY[]): Extract<Zone, { kind: 'polygon' }> {
  return { kind: 'polygon', points: points.map((p) => [p[0], p[1]] as XY) };
}

/** Why a finished zone is refused, or null when it is usable. */
export function zoneProblem(z: Zone): string | null {
  switch (z.kind) {
    case 'rect':
      return z.maxX - z.minX < MIN_SIDE_M || z.maxY - z.minY < MIN_SIDE_M ? `Each side must be at least ${MIN_SIDE_M} m. Drag the second corner further away.` : null;
    case 'circle':
      return z.r < MIN_SIDE_M ? `The radius must be at least ${MIN_SIDE_M} m. Click further from the centre.` : null;
    case 'polygon':
      if (z.points.length < 3) return 'An outline needs at least three points.';
      if (!isSimplePolygon(z.points)) return 'The outline crosses itself. Undo the last point and place it elsewhere.';
      return zoneAreaM2(z) < MIN_POLYGON_M2 ? `The outline must enclose at least ${MIN_POLYGON_M2} m².` : null;
  }
}

/** Closed outline of a zone for drawing (first point repeated at the end). */
export function zoneOutline(z: Zone, circleSegments = 96): XY[] {
  switch (z.kind) {
    case 'rect':
      return [
        [z.minX, z.minY],
        [z.maxX, z.minY],
        [z.maxX, z.maxY],
        [z.minX, z.maxY],
        [z.minX, z.minY],
      ];
    case 'circle': {
      const out: XY[] = [];
      for (let i = 0; i < circleSegments; i++) {
        const t = (i / circleSegments) * Math.PI * 2;
        out.push([z.cx + z.r * Math.cos(t), z.cy + z.r * Math.sin(t)]);
      }
      out.push([out[0]![0], out[0]![1]]);
      return out;
    }
    case 'polygon':
      return z.points.length ? [...z.points.map((p) => [p[0], p[1]] as XY), [z.points[0]![0], z.points[0]![1]]] : [];
  }
}

const metres = (m: number): string => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

/** One-line description: shape, size and area. */
export function describeZone(z: Zone): string {
  const km2 = `${(zoneAreaM2(z) / 1e6).toFixed(2)} km²`;
  switch (z.kind) {
    case 'rect':
      return `${metres(z.maxX - z.minX)} × ${metres(z.maxY - z.minY)} · ${km2}`;
    case 'circle':
      return `Radius ${metres(z.r)} · ${km2}`;
    case 'polygon':
      return `${z.points.length}-point outline · ${km2}`;
  }
}

/** What the next click does, for the zone readout while drawing. */
export function drawingPrompt(shape: ZoneShape, placed: number): string {
  if (shape === 'rect') return placed === 0 ? 'Click the first corner' : 'Click the opposite corner';
  if (shape === 'circle') return placed === 0 ? 'Click the centre' : 'Click a point on the edge';
  if (placed === 0) return 'Click the first point of the outline';
  if (placed < 3) return `${placed} point${placed === 1 ? '' : 's'} · keep clicking`;
  return `${placed} points · Enter to finish`;
}
