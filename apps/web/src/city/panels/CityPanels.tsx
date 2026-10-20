import { useCity } from '../store';
import { RouteLab } from './RouteLab';
import { CoveragePanel } from './CoveragePanel';
import { ScenarioPanel } from './ScenarioPanel';
import { CityGuide } from './CityGuide';

/** Mode panels (Route lab, Coverage & fleet, Scenarios). */
export function CityPanels() {
  const mode = useCity((s) => s.mode);
  return (
    <section className="cw-panel" aria-label="Mode panel" data-testid={`panel-${mode}`}>
      <CityGuide />
      {mode === 'route' ? <RouteLab /> : mode === 'coverage' ? <CoveragePanel /> : <ScenarioPanel />}
    </section>
  );
}
