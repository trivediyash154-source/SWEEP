import { useMemo } from 'react';
import type { Marker, PathOverlay, SceneOverlays } from './GeoCityScene';
import { arcsPath } from './overlays';
import { useCity } from './store';
import { effectiveInputs, useCoverage } from './coverageStore';
import { useScenarios } from './scenario';
import { VEHICLE_COLORS } from './panels/CoveragePanel';
import { vehiclePoses } from './shift';

type CoverageLayers = Pick<SceneOverlays, 'paths' | 'highlights' | 'markers' | 'zone'> & { vehicles: SceneOverlays['vehicles'] | undefined };

const SHOW_ALL = { current: Infinity };

/** Coverage and fleet layers: one path per vehicle, the zone outline, depot and disposal markers. */
export function useCoverageOverlays(): CoverageLayers {
  const city = useCity((s) => s.city);
  const mode = useCity((s) => s.mode);
  const zone = useCoverage((s) => s.zone);
  const cornerA = useCoverage((s) => s.cornerA);
  const planDepot = useCoverage((s) => s.depot);
  const scenario = useScenarios((s) => s.scenarios.find((x) => x.id === s.activeId));
  const depot = effectiveInputs({ depot: planDepot, fleet: useCoverage.getState().fleet }, scenario).depot;
  const dump = useCoverage((s) => s.dump);
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

  return useMemo(() => {
    const markers: Marker[] = [];
    if (city && mode === 'coverage') {
      if (depot !== null) markers.push({ id: 'depot', x: city.nodeX[depot]!, y: city.nodeY[depot]!, kind: 'depot', label: 'Depot' });
      if (dump !== null) markers.push({ id: 'dump', x: city.nodeX[dump]!, y: city.nodeY[dump]!, kind: 'dump', label: 'Disposal' });
    }
    const z: SceneOverlays['zone'] = mode !== 'coverage' ? null : zone ? zone : cornerA ? { kind: 'circle', cx: cornerA[0], cy: cornerA[1], r: 4 } : null;
    return { paths, highlights: [], markers, zone: z, vehicles: mode === 'coverage' && result ? vehiclePoses : undefined };
  }, [city, mode, depot, dump, zone, cornerA, paths, result]);
}
