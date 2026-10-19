import { useEffect } from 'react';
import { Icon } from '../../components/Icon';
import { useCity } from '../store';
import { useRoute } from '../routeStore';
import { useScenarios } from '../scenario';
import { ALGO_LABEL, PROFILE_LABEL, fmtDist, fmtTime, nodeLabel } from './RouteLab';

/**
 * Printable report of the Route Lab comparison currently shown. Every figure is
 * the engine's own result for this query (cost, settled arcs, scanned
 * transitions, median runtime, preprocessing, validation), plus the dataset
 * provenance and the profile's stated assumptions.
 */
export function RouteReport({ onClose }: { onClose: () => void }) {
  const city = useCity((s) => s.city)!;
  const { origin, destination, profile, objective, runs, meta } = useRoute();
  const scenario = useScenarios((s) => s.scenarios.find((x) => x.id === s.activeId));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!runs || origin === null || destination === null) return null;
  const pv = city.provenance;
  const found = runs.filter((r) => r.result.found);
  const costs = found.map((r) => r.result.cost);
  const agree = found.length === runs.length && costs.every((c) => Math.abs(c - costs[0]!) <= 1e-9 * Math.max(1, Math.abs(costs[0]!)));
  const best = found[0]?.result;
  return (
    <div className="cv-report" role="dialog" aria-modal="true" aria-label="Route comparison report" data-testid="route-report">
      <div className="cv-report__actions">
        <button type="button" className="btn btn--primary btn--sm" onClick={() => window.print()}>
          <Icon name="export" size={13} /> Print / save as PDF
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} data-testid="route-report-close">
          Close
        </button>
      </div>
      <article className="cv-report__page">
        <header>
          <p className="eyebrow">SWEEP · point-to-point comparison</p>
          <h1>{city.name}</h1>
          <p className="faint small">Generated {new Date().toLocaleString('en-GB')} from the comparison shown in the workspace.</p>
        </header>

        <h2>Query</h2>
        <dl className="cv-facts">
          <dt>From</dt>
          <dd>{nodeLabel(city, origin)}</dd>
          <dt>To</dt>
          <dd>{nodeLabel(city, destination)}</dd>
          <dt>Profile</dt>
          <dd>{PROFILE_LABEL[profile]}</dd>
          <dt>Objective</dt>
          <dd>{objective === 'time' ? 'fastest (travel time, including turn costs)' : 'shortest (distance)'}</dd>
          <dt>Scenario</dt>
          <dd>{scenario && scenario.id !== 'baseline' ? `${scenario.name}: ${scenario.closed.length} closures, ${scenario.oneway.length} direction changes` : 'baseline (as mapped)'}</dd>
        </dl>

        <h2>Result</h2>
        {best ? (
          <p data-testid="rep-route">
            <strong>{fmtTime(best.timeS)}</strong> over <strong>{fmtDist(best.distanceM)}</strong> · {best.turns.left} left and {best.turns.right} right turns.{' '}
            {agree ? `All ${runs.length} algorithms return the same optimal ${objective === 'time' ? 'travel time' : 'distance'}.` : 'The algorithms do not agree; see the table.'}
          </p>
        ) : (
          <p>No permitted route for this profile and scenario.</p>
        )}
        <table className="sc-table">
          <thead>
            <tr>
              <th scope="col">Algorithm</th>
              <th scope="col">Settled arcs</th>
              <th scope="col">Transitions scanned</th>
              <th scope="col">Median runtime</th>
              <th scope="col">Preprocessing</th>
              <th scope="col">Route check</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((x) => (
              <tr key={x.result.algorithm} data-testid={`rep-row-${x.result.algorithm}`}>
                <th scope="row">{ALGO_LABEL[x.result.algorithm]}</th>
                <td>{x.result.expanded.toLocaleString('en-US')}</td>
                <td>{x.result.edgesScanned.toLocaleString('en-US')}</td>
                <td>{x.result.runtimeMs < 0.1 ? `${(x.result.runtimeMs * 1000).toFixed(0)} µs` : `${x.result.runtimeMs.toFixed(2)} ms`}</td>
                <td>{x.result.preprocessing.required ? `${x.result.preprocessing.ms.toFixed(0)} ms` : 'none'}</td>
                <td>{x.validation.ok ? 'valid' : 'invalid'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="faint small">Runtimes are the median of 5 untraced runs in this browser (performance.now) and vary by machine. Settled arcs and scanned transitions are exact counts for this query.</p>

        {meta && (
          <>
            <h2>Profile assumptions</h2>
            <ul className="prov__list">
              {meta.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </>
        )}

        <h2>Data</h2>
        <p className="small">
          {pv.attribution} · {pv.license} · {pv.tiles.ok} of {pv.tiles.total} tile downloads{pv.tiles.missing.length ? ' (partial extract)' : ''} · OSM database state {pv.osmBase[0].slice(0, 10)}–{pv.osmBase[1].slice(0, 10)}.
        </p>
      </article>
    </div>
  );
}
