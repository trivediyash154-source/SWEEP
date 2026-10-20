import { useId } from 'react';
import { Icon } from '../../components/Icon';
import { useCity, type CityMode } from '../store';

interface Tool {
  mode: CityMode;
  name: string;
  what: string;
  steps: string[];
}

/** One plain sentence per tool, and steps that use the panel's own button names. */
const TOOLS: Tool[] = [
  {
    mode: 'route',
    name: 'Route lab',
    what: 'The quickest route between two places, and how much work each of five classic algorithms does to find it.',
    steps: [
      'In From, type a street name, for example “Swami Vivekanand”, and choose a result. Or press Pick and click an intersection on the map.',
      'Do the same in To, for example “Kamate”.',
      'All five algorithms run. Compare their work in the table, then press Replay search to watch the search spread.',
    ],
  },
  {
    mode: 'coverage',
    name: 'Coverage & fleet',
    what: 'Routes that drive every street in an area you draw, split across your vehicles, with a proof of how close they are to the best possible.',
    steps: ['Under Zone, choose Circle and press Draw.', 'Click the centre on the map, then a point on the edge.', 'Under Depot, press Pick and click an intersection, then press Plan coverage.'],
  },
  {
    mode: 'scenarios',
    name: 'Scenarios',
    what: 'Close a road or reverse a one-way street and see how routes, plans and costs change.',
    steps: ['Press Close a road and click a street on the map.', 'Go back to the Route lab or Coverage & fleet and run it again.', 'This panel then compares the new result with the unchanged map.'],
  },
];

/** Getting-started card at the top of the panel; hidden once closed (remembered), and one click away after that. */
export function CityGuide() {
  const mode = useCity((s) => s.mode);
  const open = useCity((s) => s.guide);
  const headId = useId();
  const st = useCity.getState();
  if (!open) {
    return (
      <p className="cw-guide-show">
        <button type="button" className="btn btn--quiet btn--sm" onClick={() => st.setGuide(true)} data-testid="city-guide-show">
          <Icon name="info" size={13} /> How does this work?
        </button>
      </p>
    );
  }
  const current = TOOLS.find((t) => t.mode === mode) ?? TOOLS[0]!;
  return (
    <section className="cw-guide" aria-labelledby={headId} data-testid="city-guide">
      <div className="cw-guide__head">
        <h2 id={headId}>Getting started</h2>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => st.setGuide(false)} data-testid="city-guide-hide">
          Hide guide
        </button>
      </div>
      <p className="small">Real OpenStreetMap data for part of Pune (Bibwewadi and VIT), computed in your browser. Three tools:</p>
      <ul className="cw-guide__tools">
        {TOOLS.map((t) => (
          <li key={t.mode}>
            <button type="button" className={`cw-guide__tool${t.mode === mode ? ' is-on' : ''}`} aria-pressed={t.mode === mode} onClick={() => st.setMode(t.mode)} data-testid={`guide-${t.mode}`}>
              {t.name}
            </button>
            <span className="small">{t.what}</span>
          </li>
        ))}
      </ul>
      <div className="cw-guide__try" data-testid="city-guide-steps">
        <p className="eyebrow">Try this in {current.name}</p>
        <ol className="small">
          {current.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </div>
    </section>
  );
}
