import { useMemo } from 'react';
import type { CityModel } from '@sweep/engine';
import { buildRibbons, roadWidth, type RibbonOut } from './geometry';
import type { ExplorationOverlay, Marker, PathOverlay, ReachOverlay, SceneOverlays } from './GeoCityScene';
import { useCity } from './store';
import { replayHead, routeHead, useRoute } from './routeStore';
import { useScenarios } from './scenario';
import { useCoverageOverlays } from './coverageOverlays';

/** Ribbon geometry for a set of segments, drawn wider than the road itself. */
export function segmentRibbon(city: CityModel, segs: readonly number[], widen = 1.6): RibbonOut {
  let pts = 0;
  for (const s of segs) pts += city.segPtOff[s + 1]! - city.segPtOff[s]!;
  const xy = new Float64Array(pts * 2);
  const off = new Int32Array(segs.length + 1);
  const widths = new Float32Array(segs.length);
  const ranks = new Float32Array(segs.length);
  let k = 0;
  segs.forEach((s, i) => {
    for (let p = city.segPtOff[s]!; p < city.segPtOff[s + 1]!; p++) {
      xy[2 * k] = city.segXY[2 * p]!;
      xy[2 * k + 1] = city.segXY[2 * p + 1]!;
      k++;
    }
    off[i + 1] = k;
    widths[i] = roadWidth(city.ways[city.segWay[s]!]!.highway) * widen;
  });
  return buildRibbons(xy, off, widths, ranks, 0, Int32Array.from(segs));
}

/** Points of an arc (segment × 2 + direction) in travel order. */
export function arcPoints(city: CityModel, arc: number): number[] {
  const s = arc >> 1;
  const a = city.segPtOff[s]!;
  const z = city.segPtOff[s + 1]!;
  const out: number[] = [];
  if ((arc & 1) === 0) for (let p = a; p < z; p++) out.push(city.segXY[2 * p]!, city.segXY[2 * p + 1]!);
  else for (let p = z - 1; p >= a; p--) out.push(city.segXY[2 * p]!, city.segXY[2 * p + 1]!);
  return out;
}

/** A continuous polyline through a sequence of arcs, with cumulative drawn distance. */
export function arcsPath(city: CityModel, arcs: readonly number[]): { points: Float64Array; dist: Float64Array } {
  const pts: number[] = [];
  for (const a of arcs) {
    const p = arcPoints(city, a);
    const start = pts.length >= 2 && pts[pts.length - 2] === p[0] && pts[pts.length - 1] === p[1] ? 2 : 0;
    for (let i = start; i < p.length; i++) pts.push(p[i]!);
  }
  const points = Float64Array.from(pts);
  const n = points.length / 2;
  const dist = new Float64Array(n);
  for (let i = 1; i < n; i++) dist[i] = dist[i - 1]! + Math.hypot(points[2 * i]! - points[2 * i - 2]!, points[2 * i + 1]! - points[2 * i - 1]!);
  return { points, dist };
}

export const ALGO_COLOR: Record<string, string> = { dijkstra: '#b7a6ff', astar: '#75e0ff', bidirectional: '#f3a7c4', alt: '#ffd98c', ch: '#7dffb8' };

function explorationFor(city: CityModel, arcs: Int32Array, count: number, color: string, id: string): ExplorationOverlay {
  let lines = 0;
  for (let i = 0; i < count; i++) {
    const s = arcs[i]! >> 1;
    lines += city.segPtOff[s + 1]! - city.segPtOff[s]! - 1;
  }
  const xy = new Float32Array(lines * 4);
  const order = new Float32Array(lines);
  let k = 0;
  for (let i = 0; i < count; i++) {
    const p = arcPoints(city, arcs[i]!);
    for (let j = 0; j + 3 < p.length; j += 2) {
      xy[4 * k] = p[j]!;
      xy[4 * k + 1] = p[j + 1]!;
      xy[4 * k + 2] = p[j + 2]!;
      xy[4 * k + 3] = p[j + 3]!;
      order[k++] = i;
    }
  }
  return { id, lines: xy, order, color, progress: replayHead, width: 6 };
}

function reachOverlay(city: CityModel, entry: Float64Array, exit: Float64Array, maxS: number): ReachOverlay {
  // Per segment, the direction reached first; its polyline oriented in travel direction.
  const segs: number[] = [];
  const arcs: number[] = [];
  for (let s = 0; s < city.segCount; s++) {
    const f = entry[2 * s] ?? Infinity;
    const r = entry[2 * s + 1] ?? Infinity;
    const a = f <= r ? 2 * s : 2 * s + 1;
    if ((entry[a] ?? Infinity) < maxS) {
      segs.push(s);
      arcs.push(a);
    }
  }
  let pts = 0;
  for (const s of segs) pts += city.segPtOff[s + 1]! - city.segPtOff[s]!;
  const xy = new Float64Array(pts * 2);
  const off = new Int32Array(segs.length + 1);
  const widths = new Float32Array(segs.length);
  const ranks = new Float32Array(segs.length);
  let k = 0;
  arcs.forEach((a, i) => {
    const p = arcPoints(city, a);
    for (let j = 0; j < p.length; j++) xy[2 * k + j] = p[j]!;
    k += p.length / 2;
    off[i + 1] = k;
    widths[i] = roadWidth(city.ways[city.segWay[segs[i]!]!]!.highway) * 1.35;
  });
  const ribbon = buildRibbons(xy, off, widths, ranks, 0, Int32Array.from(segs));
  // Arrival time per ribbon vertex, interpolated along the arc between its entry and exit times.
  const time = new Float32Array(ribbon.along.length);
  let v = 0;
  arcs.forEach((a, i) => {
    const m = off[i + 1]! - off[i]!;
    if (m < 2) return;
    const len = ribbon.along[v + 2 * (m - 1)] || 1;
    const t0 = entry[a]!;
    const t1 = exit[a]!;
    for (let q = 0; q < m * 2; q++) {
      time[v] = t0 + (Math.min(len, ribbon.along[v]!) / len) * (t1 - t0);
      v++;
    }
  });
  return { ribbon, time, bands: [300, 600, 900] };
}

export function useCityOverlays(): SceneOverlays {
  const city = useCity((s) => s.city);
  const hover = useCity((s) => s.hover);
  const selection = useCity((s) => s.selection);
  const mode = useCity((s) => s.mode);
  const origin = useRoute((s) => s.origin);
  const destination = useRoute((s) => s.destination);
  const runs = useRoute((s) => s.runs);
  const active = useRoute((s) => s.active);
  const reach = useRoute((s) => s.reach);
  const scenario = useScenarios((s) => s.scenarios.find((x) => x.id === s.activeId));
  const coverage = useCoverageOverlays();

  const routeLayers = useMemo(() => {
    const paths: PathOverlay[] = [];
    const explorations: ExplorationOverlay[] = [];
    if (!city || !runs || mode !== 'route') return { paths, explorations };
    const run = runs.find((r) => r.result.algorithm === active) ?? runs[0];
    if (run?.result.found) {
      const { points, dist } = arcsPath(city, run.result.arcs);
      paths.push({ id: `route-${run.result.algorithm}`, points, dist, tint: null, width: 14, head: routeHead });
    }
    if (run?.trace) explorations.push(explorationFor(city, run.trace.arcs, run.trace.count, ALGO_COLOR[run.result.algorithm] ?? '#ffffff', `ex-${run.result.algorithm}`));
    return { paths, explorations };
  }, [city, runs, active, mode]);

  const reachLayer = useMemo(() => (city && reach && mode === 'route' ? reachOverlay(city, reach.entryS, reach.exitS, 900) : null), [city, reach, mode]);

  const scenarioLayer = useMemo(() => {
    const highlights: SceneOverlays['highlights'] = [];
    if (!city || !scenario) return highlights;
    if (scenario.closed.length) highlights.push({ key: `closed-${scenario.id}-${scenario.closed.join(',')}`, ribbon: segmentRibbon(city, scenario.closed, 1.9), color: '#ff4d6d', opacity: 0.85 });
    if (scenario.oneway.length) highlights.push({ key: `oneway-${scenario.id}-${scenario.oneway.map((o) => o.join(':')).join(',')}`, ribbon: segmentRibbon(city, scenario.oneway.map((o) => o[0]), 1.7), color: '#ffb347', opacity: 0.85 });
    return highlights;
  }, [city, scenario]);

  return useMemo(() => {
    const highlights: SceneOverlays['highlights'] = [...scenarioLayer, ...coverage.highlights];
    const markers: Marker[] = [...coverage.markers];
    if (city) {
      if (hover?.kind === 'segment') highlights.push({ key: `hover-${hover.seg}`, ribbon: segmentRibbon(city, [hover.seg], 1.3), color: '#e9c98c', opacity: 0.55 });
      if (selection?.kind === 'segment') highlights.push({ key: `sel-${selection.seg}`, ribbon: segmentRibbon(city, [selection.seg], 1.8), color: '#e9c98c', opacity: 0.9 });
      if (city.focus && origin === null) markers.push({ id: 'focus', x: city.focus.xy[0], y: city.focus.xy[1], kind: 'focus', label: city.focus.label });
      if (mode === 'route') {
        if (origin !== null) markers.push({ id: 'origin', x: city.nodeX[origin]!, y: city.nodeY[origin]!, kind: 'origin' });
        if (destination !== null) markers.push({ id: 'destination', x: city.nodeX[destination]!, y: city.nodeY[destination]!, kind: 'destination' });
      }
    }
    return {
      paths: [...routeLayers.paths, ...coverage.paths],
      explorations: routeLayers.explorations,
      reach: reachLayer,
      markers,
      highlights,
      zone: coverage.zone,
      ...(coverage.vehicles ? { vehicles: coverage.vehicles } : {}),
    };
  }, [city, hover, selection, origin, destination, mode, routeLayers, reachLayer, scenarioLayer, coverage]);
}
