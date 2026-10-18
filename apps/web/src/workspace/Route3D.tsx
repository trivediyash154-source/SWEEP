import { useMemo } from 'react';
import { useWorkspace } from '../state/workspace';
import { usePrefs } from '../state/prefs';
import { buildCityModel } from '../three/cityModel';
import { CityScene } from '../three/CityScene';
import { routeClock } from './routeClock';

/**
 * 3D route view. Built from exactly the same graph and result as the 2D
 * canvas; the vehicle follows the ordered route using the shared playback clock.
 */
export default function Route3D() {
  const { graph, result, resultGraph, stale } = useWorkspace();
  const theme = usePrefs((s) => s.theme);
  const usable = !!result && !!resultGraph && !stale;
  const model = useMemo(() => buildCityModel(usable ? resultGraph! : graph, usable ? result : null, { seed: 99, maxBuildings: 1600 }), [usable, result, resultGraph, graph]);
  return (
    <div className="route3d" data-testid="route-3d">
      <CityScene model={model} theme={theme} mode="workspace" getProgress={() => routeClock.s} coloring="kind" showOdd={!usable} />
      {!usable && (
        <div className="route3d__msg notice notice--info" role="status">
          {stale ? 'The network changed. Re-optimise to fly the new route.' : 'Optimise the route to watch the vehicle drive it in 3D.'}
        </div>
      )}
      <p className="route3d__hint faint small">Drag to orbit · scroll to zoom · right-drag to pan</p>
    </div>
  );
}
