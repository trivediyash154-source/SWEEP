/**
 * Street-sweeping plan for a zone drawn anywhere on the map.
 *
 * The streets come live from OpenStreetMap (lib/maps.ts acquireMap → engine
 * osmToGraph). A street segment is required when the midpoint of its geometry
 * lies inside the zone; every other downloaded street may be used to travel.
 * The plan itself is SWEEP's engine, unchanged: solveZoneCoverage (exact
 * min-cost flow when one-ways are respected, exact matching or the bounded
 * heuristic when they are ignored), then planFleet for several vehicles or a
 * shift limit, and the turn-aware order of the same streets. Nothing here
 * changes a distance, bound or guarantee; it only maps them to coordinates.
 */
import { EARTH_RADIUS_M, localUnprojection, orderCoverageForTurns, planFleet, PROFILE_SPECS, solveZoneCoverage, type CheckResult, type CoverageResult, type Graph, type RouteStep, type TurnOptions, type TurnTally } from '@sweep/engine';

export type LngLatPair = [number, number];
export type Zone = { kind: 'rect'; bbox: [number, number, number, number] } | { kind: 'polygon'; ring: LngLatPair[] };

/** Zone outline as an open ring of [lng, lat]. */
export function zoneRing(z: Zone): LngLatPair[] {
  if (z.kind === 'polygon') return z.ring;
  const [s, w, n, e] = z.bbox;
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ];
}

/** [south, west, north, east] of the zone. */
export function zoneBBox(z: Zone): [number, number, number, number] {
  if (z.kind === 'rect') return z.bbox;
  let s = 90;
  let w = 180;
  let n = -90;
  let e = -180;
  for (const [x, y] of z.ring) {
    s = Math.min(s, y);
    n = Math.max(n, y);
    w = Math.min(w, x);
    e = Math.max(e, x);
  }
  return [s, w, n, e];
}

const R = EARTH_RADIUS_M;
/** Area of a ring in km² (local equirectangular projection at its mean latitude; exact enough for city zones). */
export function ringAreaKm2(ring: readonly LngLatPair[]): number {
  if (ring.length < 3) return 0;
  const lat0 = (ring.reduce((a, p) => a + p[1], 0) / ring.length) * (Math.PI / 180);
  const kx = R * Math.cos(lat0) * (Math.PI / 180);
  const ky = R * (Math.PI / 180);
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    a += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky);
  }
  return Math.abs(a) / 2 / 1e6;
}

/** Ray casting; points exactly on the boundary may fall either way. */
export function pointInRing(lng: number, lat: number, ring: readonly LngLatPair[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether two non-adjacent edges of the ring cross. */
export function ringSelfIntersects(ring: readonly LngLatPair[]): boolean {
  const n = ring.length;
  const cross = (a: LngLatPair, b: LngLatPair, c: LngLatPair): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const c = ring[j]!;
      const d = ring[(j + 1) % n]!;
      const d1 = cross(c, d, a);
      const d2 = cross(c, d, b);
      const d3 = cross(a, b, c);
      const d4 = cross(a, b, d);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    }
  }
  return false;
}

/** The inverse of the graph's own local projection, recovered from its vertices (x/y and lon/lat). */
export function graphUnprojection(graph: Graph): (p: readonly [number, number]) => LngLatPair {
  const v = graph.vertices.find((x) => x.geo);
  if (!v || !v.geo) return (p) => [p[0], p[1]];
  const ky = (Math.PI / 180) * EARTH_RADIUS_M;
  // osmToGraph: x = (lon − lon0)·kx(lat0), y = −(lat − lat0)·ky  ⇒  lat0 = lat + y/ky, lon0 = lon − x/kx.
  const lat0 = v.geo[1] + v.y / ky;
  const kx = ky * Math.cos((lat0 * Math.PI) / 180);
  const lon0 = v.geo[0] - v.x / kx;
  const un = localUnprojection(lon0, lat0);
  return (p) => un([p[0], p[1]]) as LngLatPair;
}

/** Geometry of every edge as [lng, lat] points from u to v. */
export function edgeGeometries(graph: Graph): Map<string, LngLatPair[]> {
  const un = graphUnprojection(graph);
  const pos = new Map(graph.vertices.map((v) => [v.id, (v.geo ? [v.geo[0], v.geo[1]] : un([v.x, v.y])) as LngLatPair]));
  const out = new Map<string, LngLatPair[]>();
  for (const e of graph.edges) out.set(e.id, [pos.get(e.u)!, ...(e.shape ?? []).map((p) => un(p)), pos.get(e.v)!]);
  return out;
}

/** The point halfway along a polyline (by length in degrees scaled to metres at that latitude). */
export function polylineMidpoint(pts: readonly LngLatPair[]): LngLatPair {
  if (pts.length === 1) return pts[0]!;
  const k = Math.cos(((pts[0]![1] ?? 0) * Math.PI) / 180);
  const seg = (a: LngLatPair, b: LngLatPair): number => Math.hypot((b[0] - a[0]) * k, b[1] - a[1]);
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += seg(pts[i - 1]!, pts[i]!);
  let half = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const l = seg(pts[i - 1]!, pts[i]!);
    if (half <= l || i === pts.length - 1) {
      const t = l > 0 ? Math.min(1, half / l) : 0;
      const a = pts[i - 1]!;
      const b = pts[i]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    half -= l;
  }
  return pts[pts.length - 1]!;
}

/** Mark the streets of the zone as required (midpoint inside); all others are optional for travel. */
export function zoneGraph(graph: Graph, zone: Zone, geoms = edgeGeometries(graph)): { graph: Graph; requiredSegments: number; requiredM: number } {
  const ring = zoneRing(zone);
  let requiredSegments = 0;
  let requiredM = 0;
  const edges = graph.edges.map((e) => {
    const mid = polylineMidpoint(geoms.get(e.id)!);
    const required = pointInRing(mid[0], mid[1], ring);
    if (required) {
      requiredSegments++;
      requiredM += e.weight;
    }
    return { ...e, required };
  });
  return { graph: { ...graph, edges }, requiredSegments, requiredM };
}

/** The intersection nearest to a point (only vertices with a street, which is every vertex of an osmToGraph graph). */
export function nearestVertex(graph: Graph, lng: number, lat: number): string | null {
  const k = Math.cos((lat * Math.PI) / 180);
  let best: string | null = null;
  let bd = Infinity;
  for (const v of graph.vertices) {
    if (!v.geo) continue;
    const d = ((v.geo[0] - lng) * k) ** 2 + (v.geo[1] - lat) ** 2;
    if (d < bd) [best, bd] = [v.id, d];
  }
  return best;
}

export interface SweepSettings {
  direction: 'directed' | 'undirected';
  vehicles: number;
  /** Per-vehicle shift limit in hours; null = none. */
  shiftHours: number | null;
  serviceKmh: number;
  transitKmh: number;
  turnAware: boolean;
}

export const DEFAULT_SWEEP_SETTINGS: SweepSettings = { direction: 'directed', vehicles: 1, shiftHours: null, serviceKmh: 8, transitKmh: 20, turnAware: true };

export interface SweepStep {
  edgeId: string;
  name: string;
  kind: RouteStep['kind'];
  lengthM: number;
  /** [lng, lat] at the end of the step. */
  to: LngLatPair;
}

export interface SweepRoute {
  vehicle: number;
  coords: LngLatPair[];
  steps: SweepStep[];
  distanceM: number;
  serviceM: number;
  deadheadM: number;
  seconds: number;
  feasibleShift: boolean;
}

export interface SweepPlan {
  ok: true;
  method: CoverageResult['method'];
  /** Proven optimal (exact method, no connectors) for the single closed route. */
  optimal: boolean;
  guarantee: string;
  fleetGuarantee: string | null;
  direction: SweepSettings['direction'];
  required: { segments: number; km: number };
  excludedSegments: number;
  connectors: number;
  wrongWayTraversals: number;
  totals: { distanceM: number; serviceM: number; deadheadM: number; makespanSeconds: number; vehiclesUsed: number };
  lowerBound: { distanceM: number | null; method: string | null; gap: number | null };
  fleetBounds: { distanceM: number; makespanSeconds: number; makespanGap: number | null; distanceGap: number | null } | null;
  feasibility: { ok: boolean; issues: string[] };
  turns: { ordered: boolean; before: TurnTally; after: TurnTally; lowerBoundSeconds: number | null } | null;
  checks: CheckResult[];
  depot: LngLatPair;
  routes: SweepRoute[];
  timingsMs: { total: number };
}

export interface SweepFailure {
  ok: false;
  message: string;
}

const TURNS: TurnOptions = { penalties: PROFILE_SPECS.truck.turns ?? { straight: 0, left: 0, right: 0, uturn: 0 }, banned: null };

function toRoute(vehicle: number, steps: readonly RouteStep[], geoms: Map<string, LngLatPair[]>, names: Map<string, string>, seconds: number, feasibleShift: boolean, edgeEnds: Map<string, [string, string]>): SweepRoute {
  const coords: LngLatPair[] = [];
  const out: SweepStep[] = [];
  let distanceM = 0;
  let serviceM = 0;
  for (const s of steps) {
    const g = geoms.get(s.edgeId) ?? [];
    const [u] = edgeEnds.get(s.edgeId) ?? ['', ''];
    const pts = s.from === u ? g : [...g].reverse();
    for (const p of pts) {
      const last = coords[coords.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) coords.push(p);
    }
    distanceM += s.weight;
    if (s.kind === 'service') serviceM += s.weight;
    out.push({ edgeId: s.edgeId, name: names.get(s.edgeId) ?? '', kind: s.kind, lengthM: s.weight, to: pts[pts.length - 1] ?? [0, 0] });
  }
  return { vehicle, coords, steps: out, distanceM, serviceM, deadheadM: distanceM - serviceM, seconds, feasibleShift };
}

/** Plan the sweeping of `zone` from the depot nearest to `depot`, with the engine. */
export function planSweep(fullGraph: Graph, zone: Zone, depot: LngLatPair, settings: SweepSettings): SweepPlan | SweepFailure {
  const t0 = performance.now();
  const geoms = edgeGeometries(fullGraph);
  const zg = zoneGraph(fullGraph, zone, geoms);
  if (zg.requiredSegments === 0) return { ok: false, message: 'No downloaded street has its midpoint inside the zone. Draw the zone over streets, or include more road types.' };
  const depotId = nearestVertex(zg.graph, depot[0], depot[1]);
  if (!depotId) return { ok: false, message: 'No intersection was found for the depot.' };
  const depotV = zg.graph.vertices.find((v) => v.id === depotId)!;
  const raw = solveZoneCoverage(zg.graph, { direction: settings.direction, depotId });
  if (!raw.ok) return { ok: false, message: raw.message };
  const names = new Map(zg.graph.edges.map((e) => [e.id, e.name ?? '']));
  const edgeEnds = new Map(zg.graph.edges.map((e) => [e.id, [e.u, e.v] as [string, string]]));
  const vs = settings.serviceKmh / 3.6;
  const vd = settings.transitKmh / 3.6;
  const useFleet = settings.vehicles > 1 || settings.shiftHours !== null;
  const base = {
    ok: true as const,
    method: raw.method,
    optimal: raw.optimal,
    guarantee: raw.guarantee,
    direction: settings.direction,
    required: { segments: zg.requiredSegments, km: zg.requiredM / 1000 },
    excludedSegments: raw.excluded.unserviceable.length,
    connectors: raw.connectors.paths,
    wrongWayTraversals: raw.route.wrongWayTraversals,
    lowerBound: { distanceM: raw.lowerBound?.value ?? null, method: raw.lowerBound?.method ?? null, gap: raw.gap },
    depot: (depotV.geo ? [depotV.geo[0], depotV.geo[1]] : [depot[0], depot[1]]) as LngLatPair,
  };
  if (!useFleet) {
    const cov = settings.turnAware ? orderCoverageForTurns(raw, TURNS) : null;
    const route = cov ? cov.route : raw.route;
    const seconds = route.serviceDistance / vs + (route.totalDistance - route.serviceDistance) / vd;
    return {
      ...base,
      fleetGuarantee: null,
      totals: { distanceM: route.totalDistance, serviceM: route.serviceDistance, deadheadM: route.totalDistance - route.serviceDistance, makespanSeconds: seconds, vehiclesUsed: 1 },
      fleetBounds: null,
      feasibility: { ok: true, issues: [] },
      turns: cov ? { ordered: cov.turns.reordered, before: cov.turns.before, after: cov.turns.after, lowerBoundSeconds: cov.turns.lowerBound.seconds } : null,
      checks: cov ? cov.checks : raw.checks,
      routes: [toRoute(1, route.steps, geoms, names, seconds, true, edgeEnds)],
      timingsMs: { total: performance.now() - t0 },
    };
  }
  const fp = planFleet(raw.graph, {
    vehicles: settings.vehicles,
    depotId,
    direction: settings.direction,
    objective: 'min-makespan',
    shiftSeconds: settings.shiftHours !== null ? settings.shiftHours * 3600 : null,
    serviceSpeedKmh: settings.serviceKmh,
    deadheadSpeedKmh: settings.transitKmh,
    coverage: raw,
    turns: settings.turnAware ? TURNS : null,
  });
  if (!fp.ok) return { ok: false, message: fp.message };
  return {
    ...base,
    fleetGuarantee: fp.guarantee,
    totals: { distanceM: fp.totals.distance, serviceM: fp.totals.serviceDistance, deadheadM: fp.totals.deadheadDistance, makespanSeconds: fp.totals.makespanSeconds, vehiclesUsed: fp.totals.vehiclesUsed },
    fleetBounds: { distanceM: fp.lowerBounds.totalDistance.value, makespanSeconds: fp.lowerBounds.makespanSeconds.value, makespanGap: fp.gaps.makespan, distanceGap: fp.gaps.totalDistance },
    feasibility: fp.feasibility,
    turns: fp.turns ? { ordered: fp.turns.reorderedRoutes > 0, before: fp.turns.before, after: fp.turns.after, lowerBoundSeconds: fp.turns.lowerBound?.seconds ?? null } : null,
    checks: [...raw.checks, ...fp.validation.checks],
    routes: fp.routes.map((r) => toRoute(r.vehicle, r.steps, geoms, names, r.seconds, r.feasible.shift, edgeEnds)),
    timingsMs: { total: performance.now() - t0 },
  };
}

/** GPX with one track per vehicle. */
export function planToGpx(plan: SweepPlan, name: string): string {
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const trk = plan.routes
    .map((r) => `  <trk><name>${esc(`${name}: vehicle ${r.vehicle}`)}</name><trkseg>\n${r.coords.map(([lng, lat]) => `    <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"/>`).join('\n')}\n  </trkseg></trk>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="SWEEP" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>${esc(name)}</name><copyright author="OpenStreetMap contributors"><license>https://opendatacommons.org/licenses/odbl/</license></copyright></metadata>\n${trk}\n</gpx>\n`;
}

/** CSV step list: vehicle, step, street, kind, length, cumulative, end point. */
export function planToCsv(plan: SweepPlan): string {
  const q = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = ['vehicle,step,street,kind,length_m,cumulative_km,end_lat,end_lng'];
  for (const r of plan.routes) {
    let cum = 0;
    r.steps.forEach((s, i) => {
      cum += s.lengthM;
      rows.push([r.vehicle, i + 1, q(s.name || '(unnamed)'), s.kind, s.lengthM.toFixed(1), (cum / 1000).toFixed(3), s.to[1].toFixed(6), s.to[0].toFixed(6)].join(','));
    });
  }
  return `${rows.join('\r\n')}\r\n`;
}
