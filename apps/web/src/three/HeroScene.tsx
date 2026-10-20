import { useMemo, useRef } from 'react';
import { solveChinesePostman } from '@sweep/engine';
import { heroCity } from '@sweep/engine/examples';
import { buildCityModel } from './cityModel';
import { CityScene, type SceneTheme } from './CityScene';

/** The landing-page city: a deterministic synthetic district whose route is solved live by the engine. */
export default function HeroScene({ theme, paused, reduced }: { theme: SceneTheme; paused: boolean; reduced: boolean }) {
  const model = useMemo(() => {
    const graph = heroCity();
    const r = solveChinesePostman(graph);
    return buildCityModel(graph, r.ok ? r : null, { seed: 4242, maxBuildings: 900 });
  }, []);
  const s = useRef(0);
  const hold = useRef(0);
  const total = model.route?.totalDrawn ?? 0;
  const getProgress = (dt: number): number => {
    if (reduced) return total;
    if (paused) return s.current;
    if (s.current >= total) {
      hold.current += dt;
      if (hold.current > 3.2) {
        hold.current = 0;
        s.current = 0;
      }
      return total;
    }
    s.current = Math.min(total, s.current + (total / 22) * dt);
    return s.current;
  };
  return <CityScene model={model} theme={theme} mode="hero" paused={paused || reduced} getProgress={getProgress} coloring="spectral" />;
}
