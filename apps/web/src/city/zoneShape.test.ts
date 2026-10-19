import { describe, expect, it } from 'vitest';
import { pointInZone, zoneAreaM2 } from '@sweep/engine';
import { canClose, canExtend, isSimplePolygon, circleZone, describeZone, drawingPrompt, polygonZone, rectZone, segmentsIntersect, zoneOutline, zoneProblem, type XY } from './zoneShape';

describe('zone drawing', () => {
  it('detects crossing, touching and collinear-overlapping segments, and nothing else', () => {
    expect(segmentsIntersect([0, 0], [10, 10], [0, 10], [10, 0])).toBe(true); // X
    expect(segmentsIntersect([0, 0], [10, 0], [5, 0], [5, 5])).toBe(true); // T: touches
    expect(segmentsIntersect([0, 0], [10, 0], [5, 0], [15, 0])).toBe(true); // collinear overlap
    expect(segmentsIntersect([0, 0], [10, 0], [11, 0], [15, 0])).toBe(false); // collinear, apart
    expect(segmentsIntersect([0, 0], [10, 0], [0, 1], [10, 1])).toBe(false); // parallel
    expect(segmentsIntersect([0, 0], [10, 0], [5, 1], [5, 8])).toBe(false); // short of the line
  });

  it('refuses a point that would make the outline cross itself, a repeated point, or folding back', () => {
    const square: XY[] = [
      [0, 0],
      [100, 0],
      [100, 100],
    ];
    expect(canExtend(square, [0, 100])).toBe(true);
    expect(canClose([...square, [0, 100]])).toBe(true);
    // Bow-tie: the fourth point's edge crosses the first edge.
    expect(canExtend([[0, 0], [100, 100], [100, 0]], [0, 100])).toBe(false);
    // Here every edge is fine as drawn, but closing (100,50) → (0,50) would cut through the second edge.
    expect(canExtend([[0, 50], [50, 0], [50, 100]], [100, 50])).toBe(true);
    expect(canClose([[0, 50], [50, 0], [50, 100], [100, 50]])).toBe(false);
    // A new edge across the first edge.
    expect(canExtend([[0, 0], [100, 0], [100, 100], [50, 100]], [50, -50])).toBe(false);
    expect(canExtend(square, [100, 100])).toBe(false); // same as the last point
    expect(canExtend(square, [100, 50])).toBe(false); // back along the previous edge
    expect(canExtend(square, [100, 150])).toBe(true); // straight on is fine
    expect(canExtend(square, [0, 0])).toBe(false); // onto an earlier vertex
  });

  it('recognises simple and self-crossing closed outlines', () => {
    expect(isSimplePolygon([[0, 0], [100, 0], [100, 100], [0, 100]])).toBe(true);
    expect(isSimplePolygon([[0, 0], [100, 100], [100, 0], [0, 100]])).toBe(false);
    expect(isSimplePolygon([[0, 0], [100, 0]])).toBe(false);
    // Concave (an L shape) is still simple.
    expect(isSimplePolygon([[0, 0], [200, 0], [200, 100], [100, 100], [100, 200], [0, 200]])).toBe(true);
  });

  it('builds zones the engine reads with the expected extent and area', () => {
    const r = rectZone([300, 50], [100, 250]);
    expect(r).toEqual({ kind: 'rect', minX: 100, minY: 50, maxX: 300, maxY: 250 });
    expect(zoneAreaM2(r)).toBe(40_000);
    const c = circleZone([0, 0], [30, 40]);
    expect(c.r).toBe(50);
    expect(pointInZone(c, 49.9, 0)).toBe(true);
    expect(pointInZone(c, 35.4, 35.4)).toBe(false);
    const p = polygonZone([
      [0, 0],
      [200, 0],
      [200, 100],
      [0, 100],
    ]);
    expect(zoneAreaM2(p)).toBe(20_000);
    expect(pointInZone(p, 150, 50)).toBe(true);
    expect(pointInZone(p, 250, 50)).toBe(false);
  });

  it('refuses zones too small to plan, and outlines that cannot close', () => {
    expect(zoneProblem(rectZone([0, 0], [5, 500]))).toMatch(/at least 10 m/);
    expect(zoneProblem(rectZone([0, 0], [50, 50]))).toBeNull();
    expect(zoneProblem(circleZone([0, 0], [3, 4]))).toMatch(/radius/);
    expect(zoneProblem(polygonZone([[0, 0], [5, 0], [0, 5]]))).toMatch(/100 m²/);
    expect(zoneProblem(polygonZone([[0, 0], [100, 100], [100, 0], [0, 100]]))).toMatch(/crosses itself/);
    expect(zoneProblem(polygonZone([[0, 50], [50, 0], [50, 100], [100, 50]]))).toMatch(/crosses itself/);
    expect(zoneProblem(polygonZone([[0, 0], [100, 0], [100, 100], [0, 100]]))).toBeNull();
    expect(zoneProblem(polygonZone([[0, 0], [100, 0]]))).toMatch(/three points/);
  });

  it('outlines are closed rings on the zone boundary', () => {
    for (const z of [rectZone([0, 0], [80, 60]), circleZone([10, 20], [10, 70]), polygonZone([[0, 0], [90, 10], [40, 70]])]) {
      const o = zoneOutline(z);
      expect(o[0]).toEqual(o[o.length - 1]);
    }
    const ring = zoneOutline(circleZone([10, 20], [10, 70]), 32);
    expect(ring).toHaveLength(33);
    for (const [x, y] of ring) expect(Math.hypot(x - 10, y - 20)).toBeCloseTo(50, 9);
  });

  it('describes each shape with its size and area', () => {
    expect(describeZone(rectZone([0, 0], [500, 400]))).toBe('500 m × 400 m · 0.20 km²');
    expect(describeZone(circleZone([0, 0], [0, 1500]))).toBe('Radius 1.50 km · 7.07 km²');
    expect(describeZone(polygonZone([[0, 0], [1000, 0], [1000, 1000], [0, 1000], [-200, 500]]))).toBe('5-point outline · 1.10 km²');
    expect(drawingPrompt('polygon', 0)).toMatch(/first point/);
    expect(drawingPrompt('polygon', 4)).toBe('4 points · Enter to finish');
    expect(drawingPrompt('circle', 1)).toMatch(/edge/);
  });
});
