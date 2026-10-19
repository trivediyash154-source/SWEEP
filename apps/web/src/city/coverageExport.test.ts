import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCityBundle, haversine, RoutingEngine } from '@sweep/engine';
import { plansToCsv, plansToGpx, routeLonLat, type ExportRoute } from './coverageExport';
import { buildSchedule } from './timeline';

const BUNDLE = join(__dirname, '..', '..', 'public', 'cities', 'pune-bibwewadi.json');

describe.skipIf(!existsSync(BUNDLE))('coverage plan exports on the real Pune network', () => {
  const city = decodeCityBundle(JSON.parse(readFileSync(BUNDLE, 'utf8')));
  // A real connected route (any two connected intersections), treated as a vehicle route: first half service, then transit.
  const engine = new RoutingEngine(city, 'car');
  let res = engine.query('dijkstra', { origin: 10, destination: 2000, objective: 'distance' }).result;
  for (let d = 2001; !res.found || res.arcs.length < 6; d++) res = engine.query('dijkstra', { origin: 10, destination: d, objective: 'distance' }).result;
  const arcs = Int32Array.from(res.arcs);
  const route: ExportRoute = {
    arcs,
    kinds: Uint8Array.from(res.arcs.map((_, i) => (i < res.arcs.length / 2 ? 0 : 2))),
    lengths: Float64Array.from(res.arcs.map((a) => city.segLen[a >> 1]!)),
    dumpAfterStep: [1],
  };
  const settings = { serviceSpeedKmh: 8, deadheadSpeedKmh: 20, dumpSeconds: 600 };

  it('traces the route in driving order from the origin to the destination intersection', () => {
    const pts = routeLonLat(city, arcs);
    expect(haversine(pts[0]!, [city.nodeLon[res.origin]!, city.nodeLat[res.origin]!])).toBeLessThan(0.1);
    expect(haversine(pts[pts.length - 1]!, [city.nodeLon[res.destination]!, city.nodeLat[res.destination]!])).toBeLessThan(0.1);
    // The drawn length matches the route length (segment lengths are geodesic; the polyline is close to them).
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += haversine(pts[i - 1]!, pts[i]!);
    expect(Math.abs(len - res.distanceM) / res.distanceM).toBeLessThan(0.01);
  });

  it('writes valid GPX with one track per vehicle that drives, and escapes text', () => {
    const empty: ExportRoute = { arcs: new Int32Array(0), kinds: new Uint8Array(0), lengths: new Float64Array(0), dumpAfterStep: [] };
    const gpx = plansToGpx(city, [route, empty, route], { name: 'Zone <A> & B', description: 'test "plan"', time: new Date('2026-10-19T06:00:00Z') });
    const doc = new DOMParser().parseFromString(gpx, 'application/xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    const tracks = doc.getElementsByTagName('trk');
    expect(tracks).toHaveLength(2);
    expect(tracks[1]!.getElementsByTagName('name')[0]!.textContent).toBe('Vehicle 3');
    expect(doc.getElementsByTagName('metadata')[0]!.getElementsByTagName('name')[0]!.textContent).toBe('Zone <A> & B');
    expect(tracks[0]!.getElementsByTagName('trkpt')).toHaveLength(routeLonLat(city, arcs).length);
    expect(gpx).toContain('OpenStreetMap contributors');
  });

  it('lists every street segment and unloading stop with the timeline\'s times', () => {
    const csv = plansToCsv(city, [route], settings, 6 * 3600);
    const rows = csv.trim().split('\r\n');
    expect(rows).toHaveLength(1 + arcs.length + 1); // header, segments, one unloading stop
    const sc = buildSchedule(route, settings);
    const last = rows[rows.length - 1]!.split(',');
    const hhmmss = (s: number) => new Date(Math.round(s) * 1000).toISOString().slice(11, 19);
    expect(rows[1]!.split(',')[9]).toBe('06:00:00');
    expect(last[10]).toBe(hhmmss(6 * 3600 + sc.totalSeconds));
    expect(Number(last[11])).toBeCloseTo(res.distanceM / 1000, 3);
    const unload = rows.find((r) => r.includes(',unload,'))!.split(',');
    expect(unload[9]).toBe(hhmmss(6 * 3600 + sc.end[1]!));
    expect(unload[10]).toBe(hhmmss(6 * 3600 + sc.end[1]! + 600));
    expect(rows[1]!.split(',')[2]).toBe('service');
    expect(last[2]).toBe('transit');
  });
});
