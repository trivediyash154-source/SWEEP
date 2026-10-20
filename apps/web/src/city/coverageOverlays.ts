import { useMemo } from 'react';
import type { Marker, PathOverlay, SceneOverlays } from './GeoCityScene';
import { arcsPath } from './overlays';
import { useCity } from './store';
import { useCoverage } from './coverageStore';
import { useScenarios } from './scenario';
import { VEHICLE_COLORS } from './panels/CoveragePanel';
import { vehiclePoses } from './shift';
import { circleZone, rectZone, zoneOutline, type XY } from './zoneShape';

type CoverageLayers = Pick<SceneOverlays, 'paths' | 'highlights' | 'markers' | 'zone'> & { vehicles: SceneOverlays['vehicles'] | undefined };

const SHOW_ALL = { current: Infinity };

const NO_POINTS: XY[] = [];

/** Coverage and fleet layers: one path per vehicle, the zone outline (or the zone being drawn), depot and disposal markers. */
export function useCoverageOverlays(): CoverageLayers {
  const city = useCity((s) => s.city);
  const mode = useCity((s) => s.mode);
  const zone = useCoverage((s) => s.zone);
  const draft = useCoverage((s) => s.draft);
  const shape = useCoverage((s) => s.zoneShape);
  // The ground point under the pointer, only while a zone is being drawn (two numbers, so the selector stays stable).
  const hx = useCity((s) => (s.pickTarget === 'zone' && s.hover ? s.hover.x : null));
  const hy = useCity((s) => (s.pickTarget === 'zone' && s.hover ? s.hover.y : null));
  const baseDepot = useCoverage((s) => s.depot);
  const scenarioDepot = useScenarios((s) => s.scenarios.find((x) => x.id === s.activeId)?.plan?.depot);
  const depot = scenarioDepot ?? baseDepot;
  const dump = useCoverage((s) => s.dump);
  const extraDepots = useCoverage((s) => s.extraDepots);
  const result = useCoverage((s) => s.result);

  const paths = useMemo(() => {
    const out: PathOverlay[] = [];
    if (!city || !result || mode !== 'coverage') return out;
    result.routes.forEach((r, i) => {
      if (!r.arcs.length) return;
      const { points, dist } = arcsPath(city, Array.from(r.arcs));
      out.push({ id: `cov-${i}`, points, dist, tint: VEHICLE_COLORS[i % VEHICLE_COLORS.length]!, width: 9, head: SHOW_ALL });
    });
    return out;
  }, [city, result, mode]);

  const zoneLayer = useMemo((): SceneOverlays['zone'] => {
    if (mode !== 'coverage') return null;
    if (draft.length > 0) {
      const cursor: XY | null = hx !== null && hy !== null ? [hx, hy] : null;
      const first = draft[0]!;
      const last = draft[draft.length - 1]!;
      let preview: XY[] = NO_POINTS;
      if (cursor && shape === 'rect') preview = zoneOutline(rectZone(first, cursor));
      else if (cursor && shape === 'circle') preview = zoneOutline(circleZone(first, cursor));
      else if (cursor) preview = draft.length > 1 ? [last, cursor, first] : [last, cursor];
      return { points: draft, closed: false, preview };
    }
    return zone ? { points: zoneOutline(zone).slice(0, -1), closed: true, preview: NO_POINTS } : null;
  }, [mode, draft, shape, hx, hy, zone]);

  return useMemo(() => {
    const markers: Marker[] = [];
    if (city && mode === 'coverage') {
      if (depot !== null) markers.push({ id: 'depot', x: city.nodeX[depot]!, y: city.nodeY[depot]!, kind: 'depot', label: extraDepots.length ? 'Depot 1' : 'Depot' });
      extraDepots.forEach((d, i) => markers.push({ id: `depot-${i + 2}`, x: city.nodeX[d.node]!, y: city.nodeY[d.node]!, kind: 'depot', label: `Depot ${i + 2}` }));
      if (dump !== null) markers.push({ id: 'dump', x: city.nodeX[dump]!, y: city.nodeY[dump]!, kind: 'dump', label: 'Disposal' });
    }
    return { paths, highlights: [], markers, zone: zoneLayer, vehicles: mode === 'coverage' && result ? vehiclePoses : undefined };
  }, [city, mode, depot, extraDepots, dump, zoneLayer, paths, result]);
}
