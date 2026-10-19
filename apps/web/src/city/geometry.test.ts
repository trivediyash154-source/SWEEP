import { describe, expect, it } from 'vitest';
import { buildBuildingChunks, buildRibbons } from './geometry';

/** Face normal implied by triangle winding (three.js front faces are counter-clockwise). */
function faceNormal(p: Float32Array, i: number, j: number, k: number): [number, number, number] {
  const ax = p[3 * j]! - p[3 * i]!;
  const ay = p[3 * j + 1]! - p[3 * i + 1]!;
  const az = p[3 * j + 2]! - p[3 * i + 2]!;
  const bx = p[3 * k]! - p[3 * i]!;
  const by = p[3 * k + 1]! - p[3 * i + 1]!;
  const bz = p[3 * k + 2]! - p[3 * i + 2]!;
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

describe('city geometry', () => {
  // An L-shaped footprint (concave), wound with positive signed area as the dataset guarantees.
  const ring = [0, 0, 20, 0, 20, 10, 10, 10, 10, 30, 0, 30];
  const input = {
    count: 1,
    ringOff: Int32Array.from([0, 6]),
    ringXY: Float32Array.from(ring),
    height: Float32Array.from([12]),
    heightSrc: Uint8Array.from([2]),
    osm: Float64Array.from([123456]),
  };

  it('extrudes real footprints: wall winding agrees with outward normals, roofs face up', () => {
    const [c] = buildBuildingChunks(input);
    expect(c).toBeDefined();
    const chunk = c!;
    let walls = 0;
    let roofs = 0;
    for (let t = 0; t < chunk.index.length / 3; t++) {
      const [i, j, k] = [chunk.index[3 * t]!, chunk.index[3 * t + 1]!, chunk.index[3 * t + 2]!];
      const fn = faceNormal(chunk.positions, i, j, k);
      const stored = [chunk.normals[3 * i]!, chunk.normals[3 * i + 1]!, chunk.normals[3 * i + 2]!];
      const dot = fn[0] * stored[0]! + fn[1] * stored[1]! + fn[2] * stored[2]!;
      expect(dot).toBeGreaterThan(0);
      if (chunk.part[i] === 1) {
        roofs++;
        expect(fn[1]).toBeGreaterThan(0);
      } else walls++;
      expect(chunk.triBuilding[t]).toBe(0);
    }
    expect(walls).toBe(12); // 6 edges × 2
    expect(roofs).toBe(4); // n − 2 for a simple polygon
    // Roof area equals the footprint area (20×10 + 10×20 = 400 m² for this L shape).
    let area = 0;
    for (let t = 0; t < chunk.index.length / 3; t++) {
      const i = chunk.index[3 * t]!;
      if (chunk.part[i] !== 1) continue;
      const fn = faceNormal(chunk.positions, i, chunk.index[3 * t + 1]!, chunk.index[3 * t + 2]!);
      area += Math.hypot(...fn) / 2;
    }
    expect(area).toBeCloseTo(400, 6);
    // Outward: the wall on y = 0 (edge 0→1) faces −Z (north in scene terms).
    expect(chunk.normals[2]).toBeCloseTo(-1, 6);
    expect(chunk.estimated[0]).toBe(1);
    expect(chunk.bounds[4]).toBe(12);
  });

  it('road ribbons face up and keep the segment for every triangle', () => {
    const pts = Float64Array.from([0, 0, 50, 0, 50, 40, /* second segment */ 100, 100, 60, 130]);
    const off = Int32Array.from([0, 3, 5]);
    const r = buildRibbons(pts, off, Float32Array.from([8, 6]), Float32Array.from([2, 3]), 0.1, Int32Array.from([7, 9]));
    for (let t = 0; t < r.index.length / 3; t++) {
      const fn = faceNormal(r.positions, r.index[3 * t]!, r.index[3 * t + 1]!, r.index[3 * t + 2]!);
      expect(fn[1]).toBeGreaterThan(0);
    }
    expect([...new Set(r.triSeg)]).toEqual([7, 9]);
    // Half-width offset at the start of the first (eastbound) segment.
    expect(Math.abs(r.positions[2]!)).toBeCloseTo(4, 6);
  });
});
