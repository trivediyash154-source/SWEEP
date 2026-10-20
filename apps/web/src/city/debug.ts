import type { CityModel } from '@sweep/engine';

type Project = (x: number, y: number, h: number) => [number, number] | null;

/**
 * Test helper: screen positions (normalised device coordinates) of real
 * building roofs and of open ground (at least 24 m from every street centreline
 * and 14 m outside every building's bounding box), both inside the visible part
 * of the canvas. Used by the theme
 * contrast check; not used by the app.
 */
export function sampleScene(city: CityModel, project: Project, n = 40, minNdcX = -0.35): { buildings: [number, number][]; ground: [number, number][] } {
  const inView = (p: [number, number] | null): p is [number, number] => !!p && p[0] > minNdcX && p[0] < 0.92 && p[1] > -0.85 && p[1] < 0.75;
  const order = Array.from({ length: city.buildingCount }, (_, i) => i).sort((a, b) => city.bHeight[b]! - city.bHeight[a]!);
  const buildings: [number, number][] = [];
  for (const b of order) {
    let cx = 0;
    let cy = 0;
    const a = city.bRingOff[b]!;
    const z = city.bRingOff[b + 1]!;
    for (let k = a; k < z; k++) {
      cx += city.bRingXY[2 * k]!;
      cy += city.bRingXY[2 * k + 1]!;
    }
    const p = project(cx / (z - a), cy / (z - a), city.bHeight[b]!);
    if (inView(p)) buildings.push(p);
    if (buildings.length >= n) break;
  }
  // Open ground: grid points in view that are at least ROAD_CLEAR from every street centreline
  // (true point-to-segment distance) and outside every building's bounding box grown by BLD_CLEAR.
  const ROAD_CLEAR = 24;
  const BLD_CLEAR = 14;
  const CELL = 100;
  const r = city.region;
  const cols = Math.max(1, Math.ceil((r.maxX - r.minX) / CELL));
  const rows = Math.max(1, Math.ceil((r.maxY - r.minY) / CELL));
  const cellOf = (x: number, y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - r.minY) / CELL))) * cols + Math.min(cols - 1, Math.max(0, Math.floor((x - r.minX) / CELL)));
  const roadCells = new Map<number, number[]>();
  const bldCells = new Map<number, number[]>();
  const put = (m: Map<number, number[]>, x0: number, y0: number, x1: number, y1: number, pad: number, v: number) => {
    const c0 = Math.max(0, Math.floor((Math.min(x0, x1) - pad - r.minX) / CELL));
    const c1 = Math.min(cols - 1, Math.floor((Math.max(x0, x1) + pad - r.minX) / CELL));
    const r0 = Math.max(0, Math.floor((Math.min(y0, y1) - pad - r.minY) / CELL));
    const r1 = Math.min(rows - 1, Math.floor((Math.max(y0, y1) + pad - r.minY) / CELL));
    for (let rr = r0; rr <= r1; rr++)
      for (let cc = c0; cc <= c1; cc++) {
        const k = rr * cols + cc;
        const l = m.get(k);
        if (l) l.push(v);
        else m.set(k, [v]);
      }
  };
  // Road edges: index of the first point of the edge (edges never span two segments).
  for (let s = 0; s < city.segCount; s++)
    for (let q = city.segPtOff[s]!; q < city.segPtOff[s + 1]! - 1; q++) put(roadCells, city.segXY[2 * q]!, city.segXY[2 * q + 1]!, city.segXY[2 * q + 2]!, city.segXY[2 * q + 3]!, ROAD_CLEAR, q);
  const bbox = new Float64Array(city.buildingCount * 4);
  for (let bi = 0; bi < city.buildingCount; bi++) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = city.bRingOff[bi]!; k < city.bRingOff[bi + 1]!; k++) {
      x0 = Math.min(x0, city.bRingXY[2 * k]!);
      x1 = Math.max(x1, city.bRingXY[2 * k]!);
      y0 = Math.min(y0, city.bRingXY[2 * k + 1]!);
      y1 = Math.max(y1, city.bRingXY[2 * k + 1]!);
    }
    bbox.set([x0, y0, x1, y1], 4 * bi);
    put(bldCells, x0, y0, x1, y1, BLD_CLEAR, bi);
  }
  const segDist = (q: number, x: number, y: number) => {
    const ax = city.segXY[2 * q]!;
    const ay = city.segXY[2 * q + 1]!;
    const dx = city.segXY[2 * q + 2]! - ax;
    const dy = city.segXY[2 * q + 3]! - ay;
    const L = dx * dx + dy * dy;
    const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
  };
  const ground: [number, number][] = [];
  const G = 160;
  for (let gy = 0; gy < G && ground.length < n; gy++) {
    for (let gx = 0; gx < G && ground.length < n; gx++) {
      const x = r.minX + ((gx + 0.5) / G) * (r.maxX - r.minX);
      const y = r.minY + ((gy + 0.5) / G) * (r.maxY - r.minY);
      const p = project(x, y, 0);
      if (!inView(p)) continue;
      const k = cellOf(x, y);
      if ((roadCells.get(k) ?? []).some((q) => segDist(q, x, y) < ROAD_CLEAR)) continue;
      if ((bldCells.get(k) ?? []).some((bi) => x > bbox[4 * bi]! - BLD_CLEAR && x < bbox[4 * bi + 2]! + BLD_CLEAR && y > bbox[4 * bi + 1]! - BLD_CLEAR && y < bbox[4 * bi + 3]! + BLD_CLEAR)) continue;
      ground.push(p);
    }
  }
  return { buildings, ground };
}
