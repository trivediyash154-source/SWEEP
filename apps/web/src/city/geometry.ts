import earcut from 'earcut';

/**
 * Geometry for the geographic city renderer, built from the REAL footprints and
 * street polylines of a CityModel. Pure functions (no three.js), so they run
 * in a worker and return transferable typed arrays.
 *
 * Frame: city x (east) → scene X, city y (south) → scene Z, height → scene Y.
 * Buildings are merged per spatial chunk (CHUNK metres square) so the scene
 * has a few dozen draw calls instead of tens of thousands, and off-screen
 * chunks are frustum-culled. Every triangle keeps the index of the building
 * it belongs to (picking and inspection use the real OSM feature).
 */

export const CHUNK = 500;

export interface BuildingInput {
  count: number;
  ringOff: Int32Array;
  ringXY: Float32Array;
  height: Float32Array;
  heightSrc: Uint8Array;
  osm: Float64Array;
}

export interface BuildingChunk {
  key: string;
  positions: Float32Array;
  normals: Float32Array;
  /** Per vertex: 0 wall, 1 roof. */
  part: Float32Array;
  /** Per vertex: stable per-building shade 0..1 (from the OSM id) for subtle facade variation. */
  shade: Float32Array;
  /** Per vertex: horizontal facade coordinate (metres along the wall) for window rhythm. */
  facadeU: Float32Array;
  /** Per vertex: 1 when the height is an estimate, 0 when it comes from OSM. */
  estimated: Float32Array;
  index: Uint32Array;
  /** Building index for every triangle. */
  triBuilding: Int32Array;
  bounds: [number, number, number, number, number];
}

function hash01(x: number): number {
  // Stable 0..1 hash of an integer id (splitmix-style mixing in 32-bit lanes).
  let h = (x % 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

export function buildBuildingChunks(b: BuildingInput): BuildingChunk[] {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < b.count; i++) {
    const a = b.ringOff[i]!;
    const z = b.ringOff[i + 1]!;
    let cx = 0;
    let cy = 0;
    for (let p = a; p < z; p++) {
      cx += b.ringXY[2 * p]!;
      cy += b.ringXY[2 * p + 1]!;
    }
    const n = z - a;
    const key = `${Math.floor(cx / n / CHUNK)}:${Math.floor(cy / n / CHUNK)}`;
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  }
  const out: BuildingChunk[] = [];
  for (const [key, ids] of groups) {
    let verts = 0;
    let tris = 0;
    for (const i of ids) {
      const n = b.ringOff[i + 1]! - b.ringOff[i]!;
      verts += n * 4 + n; // walls (4 per edge) + roof
      tris += n * 2 + (n - 2);
    }
    const positions = new Float32Array(verts * 3);
    const normals = new Float32Array(verts * 3);
    const part = new Float32Array(verts);
    const shade = new Float32Array(verts);
    const facadeU = new Float32Array(verts);
    const estimated = new Float32Array(verts);
    const index = new Uint32Array(tris * 3);
    const triBuilding = new Int32Array(tris);
    let v = 0;
    let t = 0;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    let maxH = 0;
    const flat: number[] = [];
    for (const i of ids) {
      const a = b.ringOff[i]!;
      const n = b.ringOff[i + 1]! - a;
      const h = b.height[i]!;
      const s = hash01(b.osm[i]!);
      const est = b.heightSrc[i] === 2 ? 1 : 0;
      if (h > maxH) maxH = h;
      // Walls: rings are wound with positive signed area, so (dy, -dx) points outwards.
      let u = 0;
      for (let k = 0; k < n; k++) {
        const x0 = b.ringXY[2 * (a + k)]!;
        const y0 = b.ringXY[2 * (a + k) + 1]!;
        const x1 = b.ringXY[2 * (a + ((k + 1) % n))]!;
        const y1 = b.ringXY[2 * (a + ((k + 1) % n)) + 1]!;
        if (x0 < minX) minX = x0;
        if (x0 > maxX) maxX = x0;
        if (y0 < minZ) minZ = y0;
        if (y0 > maxZ) maxZ = y0;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const len = Math.hypot(dx, dy) || 1;
        const nx = dy / len;
        const nz = -dx / len;
        const quad: [number, number, number, number][] = [
          [x0, 0, y0, u],
          [x1, 0, y1, u + len],
          [x1, h, y1, u + len],
          [x0, h, y0, u],
        ];
        const base = v;
        for (const [qx, qy, qz, qu] of quad) {
          positions[3 * v] = qx;
          positions[3 * v + 1] = qy;
          positions[3 * v + 2] = qz;
          normals[3 * v] = nx;
          normals[3 * v + 1] = 0;
          normals[3 * v + 2] = nz;
          part[v] = 0;
          shade[v] = s;
          facadeU[v] = qu;
          estimated[v] = est;
          v++;
        }
        // Counter-clockwise when seen from outside (three.js front faces).
        index[3 * t] = base;
        index[3 * t + 1] = base + 2;
        index[3 * t + 2] = base + 1;
        triBuilding[t++] = i;
        index[3 * t] = base;
        index[3 * t + 1] = base + 3;
        index[3 * t + 2] = base + 2;
        triBuilding[t++] = i;
        u += len;
      }
      // Roof.
      flat.length = 0;
      for (let k = 0; k < n; k++) flat.push(b.ringXY[2 * (a + k)]!, b.ringXY[2 * (a + k) + 1]!);
      const tri = earcut(flat);
      const roofBase = v;
      for (let k = 0; k < n; k++) {
        positions[3 * v] = flat[2 * k]!;
        positions[3 * v + 1] = h;
        positions[3 * v + 2] = flat[2 * k + 1]!;
        normals[3 * v + 1] = 1;
        part[v] = 1;
        shade[v] = s;
        estimated[v] = est;
        v++;
      }
      for (let k = 0; k + 2 < tri.length && t < tris; k += 3) {
        // Seen from above (+Y, north up) screen coordinates are (X, −Z), so an upward-facing
        // (counter-clockwise on screen) triangle has NEGATIVE signed area in (X, Z). Orient explicitly.
        const i0 = tri[k]!;
        let i1 = tri[k + 1]!;
        let i2 = tri[k + 2]!;
        const area = (flat[2 * i1]! - flat[2 * i0]!) * (flat[2 * i2 + 1]! - flat[2 * i0 + 1]!) - (flat[2 * i2]! - flat[2 * i0]!) * (flat[2 * i1 + 1]! - flat[2 * i0 + 1]!);
        if (area > 0) [i1, i2] = [i2, i1];
        index[3 * t] = roofBase + i0;
        index[3 * t + 1] = roofBase + i1;
        index[3 * t + 2] = roofBase + i2;
        triBuilding[t++] = i;
      }
    }
    out.push({
      key,
      positions,
      normals,
      part,
      shade,
      facadeU,
      estimated,
      index: index.subarray(0, t * 3),
      triBuilding: triBuilding.subarray(0, t),
      bounds: [minX, minZ, maxX, maxZ, maxH],
    });
  }
  return out;
}

/** Road width (metres) drawn for an OSM highway class. */
export function roadWidth(highway: string): number {
  switch (highway) {
    case 'motorway':
    case 'trunk':
      return 16;
    case 'primary':
      return 13;
    case 'secondary':
      return 11;
    case 'tertiary':
      return 9;
    case 'motorway_link':
    case 'trunk_link':
    case 'primary_link':
    case 'secondary_link':
    case 'tertiary_link':
      return 8;
    case 'residential':
    case 'unclassified':
      return 7;
    case 'living_street':
      return 5.5;
    case 'service':
      return 4.5;
    default:
      return 5;
  }
}

/** Visual importance rank of a road class (0 = most important). */
export function roadRank(highway: string): number {
  if (highway.startsWith('motorway') || highway.startsWith('trunk')) return 0;
  if (highway.startsWith('primary') || highway.startsWith('secondary')) return 1;
  if (highway.startsWith('tertiary')) return 2;
  if (highway === 'residential' || highway === 'unclassified' || highway === 'living_street') return 3;
  return 4;
}

export interface RibbonOut {
  positions: Float32Array;
  /** Per vertex: road rank (0..4). */
  rank: Float32Array;
  /** Per vertex: distance along the polyline (metres) — used by overlays. */
  along: Float32Array;
  /** Per vertex: −1 / +1 across the ribbon (for soft edges). */
  across: Float32Array;
  index: Uint32Array;
  /** Segment index for every triangle. */
  triSeg: Int32Array;
}

/**
 * Flat ribbons along polylines (one per segment), mitred at interior points
 * (miter length clamped), at height `y`. `pts` holds x,y pairs for all
 * polylines; `off` the point offsets (length n + 1).
 */
export function buildRibbons(pts: Float64Array, off: Int32Array, widths: Float32Array, ranks: Float32Array, y: number, segIds?: Int32Array): RibbonOut {
  const n = off.length - 1;
  let verts = 0;
  let tris = 0;
  for (let s = 0; s < n; s++) {
    const m = off[s + 1]! - off[s]!;
    if (m < 2) continue;
    verts += m * 2;
    tris += (m - 1) * 2;
  }
  const positions = new Float32Array(verts * 3);
  const rank = new Float32Array(verts);
  const along = new Float32Array(verts);
  const across = new Float32Array(verts);
  const index = new Uint32Array(tris * 3);
  const triSeg = new Int32Array(tris);
  let v = 0;
  let t = 0;
  for (let s = 0; s < n; s++) {
    const a = off[s]!;
    const m = off[s + 1]! - a;
    if (m < 2) continue;
    const half = widths[s]! / 2;
    const base = v;
    let dist = 0;
    for (let k = 0; k < m; k++) {
      const px = pts[2 * (a + k)]!;
      const py = pts[2 * (a + k) + 1]!;
      const prev = k > 0 ? [pts[2 * (a + k - 1)]!, pts[2 * (a + k - 1) + 1]!] : null;
      const next = k < m - 1 ? [pts[2 * (a + k + 1)]!, pts[2 * (a + k + 1) + 1]!] : null;
      let nx = 0;
      let ny = 0;
      let scale = 1;
      const n1 = prev ? norm(px - prev[0]!, py - prev[1]!) : null;
      const n2 = next ? norm(next[0]! - px, next[1]! - py) : null;
      if (n1 && n2) {
        const mx = n1[0] + n2[0];
        const my = n1[1] + n2[1];
        const ml = Math.hypot(mx, my);
        if (ml > 1e-6) {
          nx = -my / ml;
          ny = mx / ml;
          const cos = (nx * -n1[1] + ny * n1[0]) || 1;
          scale = Math.min(2.5, 1 / Math.max(0.4, Math.abs(cos)));
        } else {
          nx = -n1[1];
          ny = n1[0];
        }
      } else {
        const d = (n1 ?? n2)!;
        nx = -d[1];
        ny = d[0];
      }
      if (prev) dist += Math.hypot(px - prev[0]!, py - prev[1]!);
      for (const side of [-1, 1]) {
        positions[3 * v] = px + nx * half * scale * side;
        positions[3 * v + 1] = y;
        positions[3 * v + 2] = py + ny * half * scale * side;
        rank[v] = ranks[s]!;
        along[v] = dist;
        across[v] = side;
        v++;
      }
    }
    for (let k = 0; k < m - 1; k++) {
      const i0 = base + 2 * k;
      // Counter-clockwise when seen from above (negative signed area in (X, Z)); checked for an eastbound segment.
      index[3 * t] = i0;
      index[3 * t + 1] = i0 + 1;
      index[3 * t + 2] = i0 + 2;
      triSeg[t++] = segIds ? segIds[s]! : s;
      index[3 * t] = i0 + 1;
      index[3 * t + 1] = i0 + 3;
      index[3 * t + 2] = i0 + 2;
      triSeg[t++] = segIds ? segIds[s]! : s;
    }
  }
  return { positions, rank, along, across, index, triSeg };
}

function norm(dx: number, dy: number): [number, number] | null {
  const l = Math.hypot(dx, dy);
  return l > 1e-9 ? [dx / l, dy / l] : null;
}
