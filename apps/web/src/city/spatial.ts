import type { CityModel } from '@sweep/engine';

/**
 * Uniform-grid index over the real street network (segment polylines and
 * intersections), used for picking and hover without ray-casting the road mesh.
 */
export class SegmentIndex {
  readonly cell: number;
  private readonly minX: number;
  private readonly minY: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly segCells: Map<number, number[]> = new Map();
  private readonly nodeCells: Map<number, number[]> = new Map();

  constructor(private readonly city: CityModel, cell = 60) {
    this.cell = cell;
    const b = city.bounds;
    this.minX = b.minX - cell;
    this.minY = b.minY - cell;
    this.cols = Math.max(1, Math.ceil((b.maxX - b.minX) / cell) + 2);
    this.rows = Math.max(1, Math.ceil((b.maxY - b.minY) / cell) + 2);
    for (let s = 0; s < city.segCount; s++) {
      for (let p = city.segPtOff[s]!; p < city.segPtOff[s + 1]! - 1; p++) {
        const x0 = city.segXY[2 * p]!;
        const y0 = city.segXY[2 * p + 1]!;
        const x1 = city.segXY[2 * p + 2]!;
        const y1 = city.segXY[2 * p + 3]!;
        const c0 = this.col(Math.min(x0, x1));
        const c1 = this.col(Math.max(x0, x1));
        const r0 = this.row(Math.min(y0, y1));
        const r1 = this.row(Math.max(y0, y1));
        for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) this.add(this.segCells, r * this.cols + c, s);
      }
    }
    for (let n = 0; n < city.nodeCount; n++) this.add(this.nodeCells, this.row(city.nodeY[n]!) * this.cols + this.col(city.nodeX[n]!), n);
  }

  private col(x: number): number {
    return Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.minX) / this.cell)));
  }
  private row(y: number): number {
    return Math.max(0, Math.min(this.rows - 1, Math.floor((y - this.minY) / this.cell)));
  }
  private add(m: Map<number, number[]>, key: number, v: number): void {
    const l = m.get(key);
    if (!l) m.set(key, [v]);
    else if (l[l.length - 1] !== v) l.push(v);
  }

  /** Nearest segment to (x, y) within maxDist metres, with the distance and the position along it. */
  nearestSegment(x: number, y: number, maxDist = 25): { seg: number; dist: number } | null {
    const c = this.col(x);
    const r = this.row(y);
    const reach = Math.ceil(maxDist / this.cell);
    let best: { seg: number; dist: number } | null = null;
    const seen = new Set<number>();
    for (let dc = -reach; dc <= reach; dc++) {
      for (let dr = -reach; dr <= reach; dr++) {
        const list = this.segCells.get((r + dr) * this.cols + (c + dc));
        if (!list || r + dr < 0 || c + dc < 0 || c + dc >= this.cols) continue;
        for (const s of list) {
          if (seen.has(s)) continue;
          seen.add(s);
          const d = this.distToSegment(s, x, y);
          if (d <= maxDist && (!best || d < best.dist)) best = { seg: s, dist: d };
        }
      }
    }
    return best;
  }

  /** Nearest intersection (graph node) within maxDist metres. */
  nearestNode(x: number, y: number, maxDist = 40): { node: number; dist: number } | null {
    const c = this.col(x);
    const r = this.row(y);
    const reach = Math.ceil(maxDist / this.cell);
    let best: { node: number; dist: number } | null = null;
    for (let dc = -reach; dc <= reach; dc++) {
      for (let dr = -reach; dr <= reach; dr++) {
        const list = this.nodeCells.get((r + dr) * this.cols + (c + dc));
        if (!list || r + dr < 0 || c + dc < 0 || c + dc >= this.cols) continue;
        for (const n of list) {
          const d = Math.hypot(this.city.nodeX[n]! - x, this.city.nodeY[n]! - y);
          if (d <= maxDist && (!best || d < best.dist)) best = { node: n, dist: d };
        }
      }
    }
    return best;
  }

  distToSegment(s: number, x: number, y: number): number {
    let best = Infinity;
    const xy = this.city.segXY;
    for (let p = this.city.segPtOff[s]!; p < this.city.segPtOff[s + 1]! - 1; p++) {
      const ax = xy[2 * p]!;
      const ay = xy[2 * p + 1]!;
      const bx = xy[2 * p + 2]!;
      const by = xy[2 * p + 3]!;
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const d = Math.hypot(ax + t * dx - x, ay + t * dy - y);
      if (d < best) best = d;
    }
    return best;
  }
}
