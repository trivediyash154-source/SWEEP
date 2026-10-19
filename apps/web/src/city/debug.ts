import type { CityModel } from '@sweep/engine';

type Project = (x: number, y: number, h: number) => [number, number] | null;

/**
 * Test helper: screen positions (normalised device coordinates) of real
 * building roofs and of open ground at least 45 m from any building and
 * street, both inside the visible part of the canvas. Used by the theme
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
  const ground: [number, number][] = [];
  const r = city.region;
  for (let gy = 0; gy < 24 && ground.length < n; gy++) {
    for (let gx = 0; gx < 24 && ground.length < n; gx++) {
      const x = r.minX + ((gx + 0.5) / 24) * (r.maxX - r.minX);
      const y = r.minY + ((gy + 0.5) / 24) * (r.maxY - r.minY);
      let clear = true;
      for (let i = 0; i < city.bRingXY.length && clear; i += 2) if (Math.abs(city.bRingXY[i]! - x) < 45 && Math.abs(city.bRingXY[i + 1]! - y) < 45) clear = false;
      for (let i = 0; i < city.segXY.length && clear; i += 2) if (Math.abs(city.segXY[i]! - x) < 45 && Math.abs(city.segXY[i + 1]! - y) < 45) clear = false;
      if (!clear) continue;
      const p = project(x, y, 0);
      if (inView(p)) ground.push(p);
    }
  }
  return { buildings, ground };
}
