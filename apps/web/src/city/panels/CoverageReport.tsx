import { useEffect } from 'react';
import { Icon } from '../../components/Icon';
import { useCity } from '../store';
import { effectiveInputs, summarise, useCoverage } from '../coverageStore';
import { BASELINE, useScenarios } from '../scenario';
import { useShift } from '../shift';
import { buildSchedule, clockLabel } from '../timeline';
import { estimateCost } from '../costModel';
import { METHOD_LABEL, VEHICLE_COLORS, describeOverrides, inr, pct } from './CoveragePanel';
import { fmtDist, fmtTime, nodeLabel } from './RouteLab';
import { describeZone } from '../zoneShape';

/**
 * Printable report of the coverage plan currently shown in the workspace. Every
 * figure is read from that plan, its inputs and the dataset provenance; nothing
 * is added or rounded into a stronger claim.
 */
export function CoverageReport({ onClose }: { onClose: () => void }) {
  const city = useCity((s) => s.city)!;
  const cv = useCoverage();
  const scenario = useScenarios((s) => s.scenarios.find((x) => x.id === s.activeId)) ?? BASELINE;
  const startOfDay = useShift((s) => s.startOfDay);
  const r = cv.result;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!r || !cv.zone) return null;
  const pv = city.provenance;
  // The values the plan was made with: the panel's inputs plus the active scenario's overrides.
  const eff = effectiveInputs(cv, scenario);
  const f = eff.fleet;
  const overrides = describeOverrides(city, scenario);
  const schedules = r.routes.map((v) => buildSchedule(v, f));
  const sum = summarise(r);
  const cost = estimateCost(sum, eff.costs);
  const checks = [...r.checks, ...(r.fleet?.checks ?? [])];
  return (
    <div className="cv-report" role="dialog" aria-modal="true" aria-label="Coverage plan report" data-testid="cov-report">
      <div className="cv-report__actions">
        <button type="button" className="btn btn--primary btn--sm" onClick={() => window.print()} data-testid="cov-report-print">
          <Icon name="export" size={13} /> Print / save as PDF
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose} data-testid="cov-report-close">
          Close
        </button>
      </div>
      <article className="cv-report__page">
        <header>
          <p className="eyebrow">SWEEP · street coverage plan</p>
          <h1>{city.name}</h1>
          <p className="faint small">Generated {new Date().toLocaleString('en-GB')} from the plan shown in the workspace.</p>
        </header>

        <h2>Data</h2>
        <dl className="cv-facts">
          <dt>Source</dt>
          <dd>
            {pv.attribution} · {pv.license}
          </dd>
          <dt>Extract</dt>
          <dd data-testid="rep-tiles">
            {pv.tiles.ok} of {pv.tiles.total} tile downloads{pv.tiles.missing.length ? ` (partial: ${pv.tiles.missing.length} missing)` : ''} · OSM database state {pv.osmBase[0].slice(0, 10)}–{pv.osmBase[1].slice(0, 10)}
          </dd>
          <dt>Network</dt>
          <dd>
            {city.segCount.toLocaleString('en-US')} street segments · {city.buildingCount.toLocaleString('en-US')} building footprints
          </dd>
        </dl>

        <h2>Service zone and scenario</h2>
        <dl className="cv-facts">
          <dt>Zone</dt>
          <dd data-testid="rep-zone">{describeZone(cv.zone)}</dd>
          <dt>Required streets</dt>
          <dd data-testid="rep-required">
            {r.report.requiredSegments.toLocaleString('en-US')} segments, {r.report.requiredKm.toFixed(2)} km{cv.roadClasses ? ` (classes: ${cv.roadClasses.join(', ')})` : ' (all road classes)'}
          </dd>
          <dt>{r.depots ? 'Depots' : 'Depot'}</dt>
          <dd data-testid="rep-depots">
            {r.depots
              ? r.depots.map((d, i) => `${i + 1}. ${nodeLabel(city, d.node)} (${d.vehicles} vehicle${d.vehicles === 1 ? '' : 's'}, ${d.requiredSegments} segments)`).join('; ')
              : eff.depot !== null
                ? nodeLabel(city, eff.depot)
                : '–'}
          </dd>
          <dt>Disposal site</dt>
          <dd>{cv.dump !== null ? nodeLabel(city, cv.dump) : 'none'}</dd>
          <dt>One-way model</dt>
          <dd>{r.direction === 'directed' ? 'respected (directed; two-way streets serviced in both directions)' : `ignored (undirected relaxation; ${r.wrongWayTraversals} wrong-way traversals)`}</dd>
          <dt>Scenario</dt>
          <dd data-testid="rep-scenario">
            {scenario.id !== 'baseline' ? `${scenario.name}: ${scenario.closed.length} closures, ${scenario.oneway.length} direction changes${overrides.length ? `; ${overrides.join(', ')}` : ''}` : 'baseline (as mapped)'}
          </dd>
        </dl>

        <h2>Method and guarantee</h2>
        <p data-testid="rep-method">
          <strong>{METHOD_LABEL[r.method]}</strong> · {r.optimal ? 'proven optimal' : r.gap !== null ? `within ${pct(r.gap)} of a valid lower bound` : 'no optimality guarantee'}
        </p>
        <p className="small">{r.guarantee}</p>
        <dl className="cv-facts">
          <dt>{r.fleet ? 'Total distance, all vehicles' : 'Total distance'}</dt>
          <dd data-testid="rep-total">{fmtDist(sum.distanceM)}</dd>
          {r.fleet && (
            <>
              <dt>Single closed route</dt>
              <dd>{fmtDist(r.totals.distanceM)} (split into the vehicle routes below)</dd>
            </>
          )}
          <dt>Lower bound</dt>
          <dd>{r.lowerBoundM !== null ? `${fmtDist(r.lowerBoundM)} (${r.lowerBoundMethod})` : 'none'}</dd>
          <dt>Service / transit</dt>
          <dd>
            {fmtDist(sum.serviceM)} / {fmtDist(sum.transitM)}
          </dd>
        </dl>

        <h2>Fleet</h2>
        <p className="small">
          {f.vehicles} vehicle{f.vehicles === 1 ? '' : 's'} · objective {f.objective === 'min-makespan' ? 'finish soonest' : 'least total driving'} · service {f.serviceSpeedKmh} km/h, transit {f.deadheadSpeedKmh} km/h · shift limit {f.shiftSeconds === null ? 'none' : fmtTime(f.shiftSeconds)} · capacity {f.capacity ?? 'none'} · unloading {Math.round(f.dumpSeconds / 60)} min. These are planning inputs, not measured values.
        </p>
        {r.fleet && <p className="small">{r.fleet.guarantee}</p>}
        {r.fleet && r.fleet.totals.vehiclesUsed > f.vehicles && (
          <p className="small" data-testid="rep-overfleet">
            <strong>Not feasible with {f.vehicles} vehicle{f.vehicles === 1 ? '' : 's'}:</strong> the plan uses {r.fleet.totals.vehiclesUsed} routes to stay within the limits
            {r.fleet.lowerBounds.vehiclesByShift !== null ? `, and any plan needs at least ${r.fleet.lowerBounds.vehiclesByShift} vehicles for this shift` : ''}.
          </p>
        )}
        <table className="sc-table">
          <thead>
            <tr>
              <th scope="col">Vehicle</th>
              <th scope="col">Departs</th>
              <th scope="col">Returns</th>
              <th scope="col">Distance</th>
              <th scope="col">Trips</th>
              <th scope="col">Limits</th>
            </tr>
          </thead>
          <tbody>
            {r.routes.map((v, i) => (
              <tr key={v.vehicle} data-testid={`rep-vehicle-${i}`}>
                <th scope="row">
                  <i className="cv-swatch" style={{ background: VEHICLE_COLORS[i % VEHICLE_COLORS.length] }} aria-hidden="true" /> {i + 1}
                </th>
                <td>{clockLabel(startOfDay)}</td>
                <td>{clockLabel(startOfDay + schedules[i]!.totalSeconds)}</td>
                <td>{fmtDist(v.distanceM)}</td>
                <td>{v.trips}</td>
                <td>{v.feasible.shift && v.feasible.capacity ? 'within' : 'exceeded'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>Cost estimate (your assumptions)</h2>
        <p className="small">
          Fuel {cost.fuelL === null ? 'not estimated (fuel rates not entered)' : `${cost.fuelL.toFixed(1)} L`} · CO₂ {cost.co2Kg === null ? '–' : `${cost.co2Kg.toFixed(1)} kg at ${eff.costs.co2KgPerL} kg/L`} · fuel cost {inr(cost.fuelCost)} · labour {inr(cost.labourCost)} · total {inr(cost.totalCost)}. Derived only from the entered rates; not measured municipal figures.
        </p>

        <h2>Independent checks</h2>
        <ul className="cv-report__checks">
          {checks.map((c, i) => (
            <li key={`${c.id}-${i}`}>
              {c.passed ? '✓' : '✗'} {c.label}
            </li>
          ))}
        </ul>
        <p className="faint small">
          {checks.filter((c) => c.passed).length} of {checks.length} passed. Map data © OpenStreetMap contributors, {pv.license}.
        </p>
      </article>
    </div>
  );
}
