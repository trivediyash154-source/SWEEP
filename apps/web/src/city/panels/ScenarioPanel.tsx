import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { useCity } from '../store';
import { useRoute } from '../routeStore';
import { BASELINE, specOf, useScenarios } from '../scenario';
import { segmentLabel } from '../Inspector';
import { router } from '../routerClient';
import type { RouterResponse } from '../router.worker';
import { rerunAll } from '../actions';
import { fmtDist, fmtTime, nodeLabel } from './RouteLab';

interface Comparison {
  baseline: { found: boolean; timeS: number; distanceM: number };
  scenario: { found: boolean; timeS: number; distanceM: number };
  key: string;
}

const DIR_TEXT = { forward: 'one-way in mapped direction', reverse: 'one-way against mapped direction', 'two-way': 'two-way' } as const;

export function ScenarioPanel() {
  const city = useCity((s) => s.city)!;
  const pickTarget = useCity((s) => s.pickTarget);
  const scenarios = useScenarios((s) => s.scenarios);
  const activeId = useScenarios((s) => s.activeId);
  const active = scenarios.find((s) => s.id === activeId) ?? BASELINE;
  const origin = useRoute((s) => s.origin);
  const destination = useRoute((s) => s.destination);
  const profile = useRoute((s) => s.profile);
  const objective = useRoute((s) => s.objective);
  const sc = useScenarios.getState();
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const compare = async () => {
    if (origin === null || destination === null) return;
    setBusy(true);
    setErr(null);
    try {
      const ask = (spec: ReturnType<typeof specOf>) => router.send<Extract<RouterResponse, { op: 'route' }>>({ op: 'route', profile, objective, origin, destination, algorithms: ['dijkstra'], scenario: spec, repeat: 1 });
      const [b, s] = await Promise.all([ask(specOf(BASELINE)), ask(specOf(active))]);
      const pick = (r: Extract<RouterResponse, { op: 'route' }>) => ({ found: r.runs[0]!.result.found, timeS: r.runs[0]!.result.timeS, distanceM: r.runs[0]!.result.distanceM });
      setCmp({ baseline: pick(b), scenario: pick(s), key: specOf(active).key });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const tool = (t: 'close-road' | 'make-oneway') => {
    useCity.getState().setPickTarget(pickTarget === t ? null : t);
  };
  const changed = active.closed.length + active.oneway.length;
  const delta = (a: number, b: number, f: (x: number) => string) => (Number.isFinite(a) && Number.isFinite(b) ? `${b - a >= 0 ? '+' : '−'}${f(Math.abs(b - a))}` : '–');

  return (
    <>
      <header>
        <p className="eyebrow">Scenarios · what if</p>
        <h2>Change the city. Recompute everything.</h2>
        <p className="muted small">Every change edits the real network the solvers use: closed roads disappear from the routing and coverage graphs, and direction changes alter which arcs exist. The baseline stays untouched for comparison.</p>
      </header>

      <div className="sc-list" role="radiogroup" aria-label="Scenarios">
        {scenarios.map((s) => (
          <div key={s.id} className={`sc-item${s.id === activeId ? ' is-on' : ''}`}>
            <button
              type="button"
              role="radio"
              aria-checked={s.id === activeId}
              className="sc-item__pick"
              onClick={() => {
                sc.setActive(s.id);
                setCmp(null);
                rerunAll();
              }}
              data-testid={`scenario-${s.id === 'baseline' ? 'baseline' : 'custom'}`}
            >
              <strong>{s.name}</strong>
              <span className="faint small">{s.id === 'baseline' ? 'As mapped in OpenStreetMap' : `${s.closed.length} closure${s.closed.length === 1 ? '' : 's'} · ${s.oneway.length} direction change${s.oneway.length === 1 ? '' : 's'}`}</span>
            </button>
            {s.id !== 'baseline' && (
              <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Delete ${s.name}`} onClick={() => {
                sc.remove(s.id);
                setCmp(null);
                rerunAll();
              }}>
                <Icon name="delete" size={13} />
              </button>
            )}
          </div>
        ))}
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => {
          sc.create();
          setCmp(null);
        }} data-testid="new-scenario">
          <Icon name="add" size={13} /> New scenario from current
        </button>
      </div>

      <div className="sc-tools" role="toolbar" aria-label="Scenario edits">
        <button type="button" className={`btn btn--quiet btn--sm${pickTarget === 'close-road' ? ' is-on' : ''}`} aria-pressed={pickTarget === 'close-road'} onClick={() => tool('close-road')} data-testid="tool-close-road">
          <Icon name="cross" size={13} /> Close a road
        </button>
        <button type="button" className={`btn btn--quiet btn--sm${pickTarget === 'make-oneway' ? ' is-on' : ''}`} aria-pressed={pickTarget === 'make-oneway'} onClick={() => tool('make-oneway')} data-testid="tool-oneway">
          <Icon name="oneway" size={13} /> Change direction
        </button>
      </div>
      {(pickTarget === 'close-road' || pickTarget === 'make-oneway') && (
        <p className="sc-hint small" role="status">
          {pickTarget === 'close-road' ? 'Click a street to close it (click again to reopen). The baseline becomes a new scenario automatically.' : 'Click a street to cycle its direction: one-way mapped → one-way reversed → two-way → as mapped.'}
        </p>
      )}

      {changed > 0 && (
        <ul className="sc-changes" data-testid="scenario-changes">
          {active.closed.map((s) => (
            <li key={`c${s}`}>
              <span className="sc-tag sc-tag--closed">closed</span> {segmentLabel(city, s)} <span className="faint small">({fmtDist(city.segLen[s]!)})</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => {
                sc.toggleClosed(s);
                rerunAll();
              }}>
                Reopen
              </button>
            </li>
          ))}
          {active.oneway.map(([s, d]) => (
            <li key={`o${s}`}>
              <span className="sc-tag sc-tag--dir">direction</span> {segmentLabel(city, s)} → {DIR_TEXT[d]}
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => {
                sc.setOneway(s, null);
                rerunAll();
              }}>
                Undo
              </button>
            </li>
          ))}
        </ul>
      )}

      <section className="sc-compare" aria-label="Comparison with baseline">
        <h3>Route impact</h3>
        {origin === null || destination === null ? (
          <p className="faint small">Set an origin and destination in the Route lab to measure how this scenario changes the trip.</p>
        ) : (
          <>
            <p className="faint small">
              {nodeLabel(city, origin)} → {nodeLabel(city, destination)} · {profile} · {objective === 'time' ? 'fastest' : 'shortest'}
            </p>
            <button type="button" className="btn btn--primary btn--sm" disabled={busy || activeId === 'baseline'} onClick={() => void compare()} data-testid="compare-baseline">
              {busy ? <span className="spinner" aria-hidden="true" /> : null} Compare with baseline
            </button>
            {err && <p className="notice notice--warn small">{err}</p>}
            {cmp && cmp.key === specOf(active).key && (
              <table className="sc-table" data-testid="scenario-comparison">
                <thead>
                  <tr>
                    <th />
                    <th scope="col">Baseline</th>
                    <th scope="col">{active.name}</th>
                    <th scope="col">Change</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Travel time</th>
                    <td>{cmp.baseline.found ? fmtTime(cmp.baseline.timeS) : 'no route'}</td>
                    <td data-testid="scenario-time">{cmp.scenario.found ? fmtTime(cmp.scenario.timeS) : 'no route'}</td>
                    <td>{cmp.baseline.found && cmp.scenario.found ? delta(cmp.baseline.timeS, cmp.scenario.timeS, (x) => fmtTime(x)) : '–'}</td>
                  </tr>
                  <tr>
                    <th scope="row">Distance</th>
                    <td>{cmp.baseline.found ? fmtDist(cmp.baseline.distanceM) : '–'}</td>
                    <td>{cmp.scenario.found ? fmtDist(cmp.scenario.distanceM) : '–'}</td>
                    <td>{cmp.baseline.found && cmp.scenario.found ? delta(cmp.baseline.distanceM, cmp.scenario.distanceM, fmtDist) : '–'}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
    </>
  );
}
