import { useEffect, useMemo } from 'react';
import type { AlgorithmId, ProfileId } from '@sweep/engine';
import { Icon } from '../../components/Icon';
import { useCity } from '../store';
import { useRoute } from '../routeStore';
import { specOf, useScenarios } from '../scenario';
import { segmentLabel } from '../Inspector';
import { routeSheet, TURN_TEXT } from '../routeSheet';
import { fmtDist, fmtTime } from '../format';
import { nodeLabel } from './RouteLab';

const ALGO_LABEL: Record<AlgorithmId, string> = { dijkstra: 'Dijkstra', astar: 'A*', bidirectional: 'Bidirectional', alt: 'ALT (landmarks)', ch: 'Contraction Hierarchies' };
const PROFILE_LABEL: Record<ProfileId, string> = { car: 'car', truck: 'truck', bicycle: 'bicycle', foot: 'walking' };

/**
 * Printable report of the Route lab comparison currently shown. Every figure is
 * read from the computed runs, their independent validation, the profile
 * assumptions and the dataset provenance; nothing is added or rounded into a
 * stronger claim. Runtimes are this browser's measurements, labelled as such.
 */
export function RouteReport({ onClose }: { onClose: () => void }) {
  const city = useCity((s) => s.city)!;
  const { origin, destination, profile, objective, runs, meta, active, reach, scenarioKey } = useRoute();
  const scenarios = useScenarios((s) => s.scenarios);
  const activeId = useScenarios((s) => s.activeId);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const best = runs?.find((x) => x.result.algorithm === active) ?? runs?.[0];
  const legs = useMemo(() => (best?.result.found ? routeSheet(city, best.result.arcs, (s) => segmentLabel(city, s)) : []), [city, best]);
  if (!runs || !best || origin === null || destination === null) return null;
  const pv = city.provenance;
  const r = best.result;
  // The scenario the shown results were computed on (the active one may have changed since).
  const computedOn = scenarios.find((s) => specOf(s).key === scenarioKey);
  const activeScenario = scenarios.find((s) => s.id === activeId);
  const stale = !activeScenario || specOf(activeScenario).key !== scenarioKey;
  const costText = (c: number) => (objective === 'time' ? fmtTime(c) : fmtDist(c));
  const allFound = runs.every((x) => x.result.found);
  const maxRel = allFound ? Math.max(...runs.map((x) => Math.abs(x.result.cost - runs[0]!.result.cost) / Math.max(1e-9, runs[0]!.result.cost))) : null;
  const place = (n: number) => `${nodeLabel(city, n)} (${city.nodeLat[n]!.toFixed(5)}°N, ${city.nodeLon[n]!.toFixed(5)}°E, OSM node ${city.nodeOsm[n]})`;

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
          <p className="eyebrow">SWEEP · point-to-point route comparison</p>
          <h1>{city.name}</h1>
          <p className="faint small">Generated {new Date().toLocaleString('en-GB')} from the comparison shown in the Route lab.</p>
        </header>

        <h2>Data</h2>
        <dl className="cv-facts">
          <dt>Source</dt>
          <dd>
            {pv.attribution} · {pv.license}
          </dd>
          <dt>Extract</dt>
          <dd data-testid="rrep-tiles">
            {pv.tiles.ok} of {pv.tiles.total} tile downloads{pv.tiles.missing.length ? ` (partial: ${pv.tiles.missing.length} missing)` : ''} · OSM database state {pv.osmBase[0].slice(0, 10)}–{pv.osmBase[1].slice(0, 10)}
          </dd>
          {meta && (
            <>
              <dt>Routing graph</dt>
              <dd>
                {meta.graphStats.allowedArcs.toLocaleString('en-US')} permitted directed arcs, {meta.graphStats.transitions.toLocaleString('en-US')} turn transitions for the {PROFILE_LABEL[profile]} profile
              </dd>
            </>
          )}
        </dl>

        <h2>Query</h2>
        <dl className="cv-facts">
          <dt>From</dt>
          <dd data-testid="rrep-from">{place(origin)}</dd>
          <dt>To</dt>
          <dd data-testid="rrep-to">{place(destination)}</dd>
          <dt>Profile</dt>
          <dd>
            {PROFILE_LABEL[profile]} · {objective === 'time' ? 'fastest (travel time, with turn penalties)' : 'shortest (distance)'}
          </dd>
          <dt>Scenario</dt>
          <dd data-testid="rrep-scenario">
            {computedOn ? (computedOn.id === 'baseline' ? 'baseline (as mapped)' : `${computedOn.name}: ${computedOn.closed.length} closures, ${computedOn.oneway.length} direction changes`) : 'a scenario that no longer exists'}
            {stale ? ' · the active scenario has changed since; run the comparison again to update' : ''}
          </dd>
        </dl>

        <h2>Result</h2>
        {r.found ? (
          <dl className="cv-facts">
            <dt>Travel time</dt>
            <dd data-testid="rrep-time">{fmtTime(r.timeS)}</dd>
            <dt>Distance</dt>
            <dd data-testid="rrep-distance">{fmtDist(r.distanceM)}</dd>
            <dt>Turns</dt>
            <dd>
              {r.turns.left} left · {r.turns.right} right · {r.turns.straight} straight · {r.turns.uturn} U-turns
            </dd>
            <dt>Agreement</dt>
            <dd data-testid="rrep-agreement">
              {maxRel === null ? 'Not every algorithm found a route.' : maxRel <= 1e-9 ? `All ${runs.length} algorithms return the same optimal ${objective === 'time' ? 'travel time' : 'distance'} (largest relative difference ${maxRel.toExponential(1)}).` : `Costs differ by up to ${(maxRel * 100).toExponential(2)} %: a defect.`}
            </dd>
          </dl>
        ) : (
          <p className="small">No permitted route exists between these points for this profile and scenario.</p>
        )}

        <h2>Algorithms</h2>
        <table className="sc-table" data-testid="rrep-algorithms">
          <thead>
            <tr>
              <th scope="col">Algorithm</th>
              <th scope="col">{objective === 'time' ? 'Time' : 'Distance'}</th>
              <th scope="col">Arcs settled</th>
              <th scope="col">Query time</th>
              <th scope="col">Preprocessing</th>
              <th scope="col">Checks</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((x) => (
              <tr key={x.result.algorithm} data-testid={`rrep-row-${x.result.algorithm}`}>
                <th scope="row">{ALGO_LABEL[x.result.algorithm]}</th>
                <td>{x.result.found ? costText(x.result.cost) : 'no route'}</td>
                <td data-testid={`rrep-settled-${x.result.algorithm}`}>{x.result.expanded.toLocaleString('en-US')}</td>
                <td>{x.result.runtimeMs < 0.1 ? `${(x.result.runtimeMs * 1000).toFixed(0)} µs` : `${x.result.runtimeMs.toFixed(2)} ms`}</td>
                <td>{x.result.preprocessing.required ? `${x.result.preprocessing.ms.toFixed(0)} ms` : 'none'}</td>
                <td>
                  {x.validation.checks.filter((c) => c.passed).length} of {x.validation.checks.length}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="faint small">Query time: median of {r.runs} untraced runs in this browser (performance.now); it depends on the device. Arcs settled count the search work, independent of the device.</p>

        {legs.length > 0 && (
          <>
            <h2>Route sheet ({ALGO_LABEL[r.algorithm]})</h2>
            <table className="sc-table" data-testid="rrep-sheet">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Direction</th>
                  <th scope="col">Distance</th>
                  <th scope="col">From start</th>
                </tr>
              </thead>
              <tbody>
                {legs.map((l, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>
                      {TURN_TEXT[l.turn]} {l.street}
                    </td>
                    <td>{fmtDist(l.distanceM)}</td>
                    <td>{fmtDist(l.cumulativeM)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="faint small">Turns are classified as the routing graph classifies them: within 30° is straight; traffic keeps left.</p>
          </>
        )}

        {reach && (
          <>
            <h2>Reachable from the origin</h2>
            <ul className="small" data-testid="rrep-reach">
              {reach.levels.map((l) => (
                <li key={l.thresholdS}>
                  {l.thresholdS / 60} min: {fmtDist(l.lengthM)} of street, {l.nodes.toLocaleString('en-US')} intersections
                </li>
              ))}
            </ul>
          </>
        )}

        {meta && (
          <>
            <h2>Assumptions ({PROFILE_LABEL[profile]} profile)</h2>
            <ul className="small">
              {meta.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </>
        )}

        <h2>Independent checks ({ALGO_LABEL[r.algorithm]})</h2>
        <ul className="cv-report__checks">
          {best.validation.checks.map((c, i) => (
            <li key={`${c.id}-${i}`}>
              {c.passed ? '✓' : '✗'} {c.id}: {c.detail}
            </li>
          ))}
        </ul>
        <p className="faint small">Map data © OpenStreetMap contributors, {pv.license}.</p>
      </article>
    </div>
  );
}
