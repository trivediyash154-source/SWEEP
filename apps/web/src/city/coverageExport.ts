import { localUnprojection, toCsv, type CityModel } from '@sweep/engine';
import { buildSchedule, type TimelineSettings } from './timeline';

/**
 * Exports of a coverage plan for crews and navigation devices: GPX 1.1 (one
 * track per vehicle, in driving order) and a step-by-step CSV whose times come
 * from the same schedule as the shift timeline. Coordinates are converted back
 * from the bundle's local frame with the inverse of its projection.
 */

export interface ExportRoute {
  /** Arcs: segment × 2 + direction (0 = as digitised in OSM, 1 = against). */
  arcs: Int32Array;
  /** 0 service, 1 repeat, 2 deadhead. */
  kinds: Uint8Array;
  lengths: Float64Array;
  dumpAfterStep: readonly number[];
}

const KIND_TEXT = ['service', 'repeat', 'transit'] as const;

const streetName = (city: CityModel, seg: number): string => {
  const w = city.ways[city.segWay[seg]!]!;
  return w.name ?? w.ref ?? `Unnamed ${w.highway.replace(/_/g, ' ')}`;
};

/** Points of an arc's polyline in travel direction, in local metres. */
function arcXY(city: CityModel, arc: number): [number, number][] {
  const s = arc >> 1;
  const a = city.segPtOff[s]!;
  const z = city.segPtOff[s + 1]!;
  const out: [number, number][] = [];
  if ((arc & 1) === 0) for (let p = a; p < z; p++) out.push([city.segXY[2 * p]!, city.segXY[2 * p + 1]!]);
  else for (let p = z - 1; p >= a; p--) out.push([city.segXY[2 * p]!, city.segXY[2 * p + 1]!]);
  return out;
}

/** [lon, lat] points of a route in driving order; the shared point between consecutive arcs appears once. */
export function routeLonLat(city: CityModel, arcs: ArrayLike<number>): [number, number][] {
  const inv = localUnprojection(city.origin[0], city.origin[1]);
  const out: [number, number][] = [];
  let last: [number, number] | null = null;
  for (let i = 0; i < arcs.length; i++) {
    for (const p of arcXY(city, arcs[i]!)) {
      if (last && last[0] === p[0] && last[1] === p[1]) continue;
      out.push(inv(p));
      last = p;
    }
  }
  return out;
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GPX 1.1 with one track per vehicle that drives anything. */
export function plansToGpx(city: CityModel, routes: readonly ExportRoute[], meta: { name: string; description: string; time: Date }): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="SWEEP" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <metadata>',
    `    <name>${xml(meta.name)}</name>`,
    `    <desc>${xml(meta.description)}</desc>`,
    '    <copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/1-0/</license></copyright>',
    `    <time>${meta.time.toISOString()}</time>`,
    '  </metadata>',
  ];
  routes.forEach((r, i) => {
    if (!r.arcs.length) return;
    const km = r.lengths.reduce((a, l) => a + l, 0) / 1000;
    lines.push('  <trk>', `    <name>Vehicle ${i + 1}</name>`, `    <desc>${km.toFixed(2)} km, ${r.arcs.length} street segments in driving order</desc>`, '    <trkseg>');
    for (const [lon, lat] of routeLonLat(city, r.arcs)) lines.push(`      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"/>`);
    lines.push('    </trkseg>', '  </trk>');
  });
  lines.push('</gpx>', '');
  return lines.join('\n');
}

const clock = (s: number): string => {
  const t = Math.round(s);
  const h = Math.floor(t / 3600) % 24;
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

/**
 * One row per street segment driven (and per unloading stop), with times of day
 * from `startOfDay` (seconds after midnight) and the planned speeds.
 */
export function plansToCsv(city: CityModel, routes: readonly ExportRoute[], settings: TimelineSettings, startOfDay: number): string {
  const rows: (string | number)[][] = [['vehicle', 'step', 'activity', 'street', 'osm_way', 'from_osm_node', 'to_osm_node', 'direction', 'length_m', 'start', 'end', 'cumulative_km']];
  routes.forEach((r, v) => {
    const sc = buildSchedule(r, settings);
    const dumps = new Set(r.dumpAfterStep);
    let km = 0;
    for (let i = 0; i < r.arcs.length; i++) {
      const arc = r.arcs[i]!;
      const seg = arc >> 1;
      const fwd = (arc & 1) === 0;
      const from = fwd ? city.segU[seg]! : city.segV[seg]!;
      const to = fwd ? city.segV[seg]! : city.segU[seg]!;
      km += r.lengths[i]! / 1000;
      rows.push([v + 1, i + 1, KIND_TEXT[r.kinds[i]!] ?? 'transit', streetName(city, seg), city.ways[city.segWay[seg]!]!.id, city.nodeOsm[from]!, city.nodeOsm[to]!, fwd ? 'as mapped' : 'against mapped', r.lengths[i]!.toFixed(1), clock(startOfDay + sc.start[i]!), clock(startOfDay + sc.end[i]!), km.toFixed(3)]);
      if (dumps.has(i)) rows.push([v + 1, i + 1, 'unload', '', '', city.nodeOsm[to]!, '', '', 0, clock(startOfDay + sc.end[i]!), clock(startOfDay + sc.end[i]! + settings.dumpSeconds), km.toFixed(3)]);
    }
  });
  return toCsv(rows);
}
