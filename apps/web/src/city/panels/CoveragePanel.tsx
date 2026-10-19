import { useMemo, useState } from 'react';
import type { CityModel } from '@sweep/engine';
import { Icon } from '../../components/Icon';
import { useCity } from '../store';
import { coverageKey, useCoverage, type PlanSummary } from '../coverageStore';
import { useScenarios } from '../scenario';
import { fmtDist, fmtTime, nodeLabel } from './RouteLab';
import { estimateCost } from '../costModel';
import { CoverageReport } from './CoverageReport';

export const METHOD_LABEL = {
  'exact-directed-min-cost-flow': 'Exact · directed min-cost flow',
  'exact-undirected-edmonds-johnson': 'Exact · undirected matching (Edmonds–Johnson)',
  'heuristic-candidate-matching': 'Heuristic · candidate matching',
} as const;

export const VEHICLE_COLORS = ['#7dffb8', '#75e0ff', '#ffd98c', '#f3a7c4', '#b7a6ff', '#ff9f6e', '#9be15d', '#e9c98c'];

/** Road classes present in the city, longest first. */
function useClasses(city: CityModel) {
  return useMemo(() => {
    const len = new Map<string, number>();
    for (let s = 0; s < city.segCount; s++) {
      const c = city.ways[city.segWay[s]!]!.highway;
      len.set(c, (len.get(c) ?? 0) + city.segLen[s]!);
    }
    return [...len.entries()].sort((a, b) => b[1] - a[1]);
  }, [city]);
}

export const inr = (x: number | null) => (x === null ? '–' : `₹${Math.round(x).toLocaleString('en-IN')}`);
export const pct = (x: number | null) => (x === null ? '–' : `${(x * 100).toFixed(2)} %`);

function NumberField({ label, value, onChange, min, max, step, placeholder, testid, unit }: { label: string; value: number | null; onChange: (v: number | null) => void; min: number; max: number; step: number; placeholder?: string; testid: string; unit?: string }) {
  return (
    <label className="cv-field">
      <span>{label}</span>
      <span className="cv-field__in">
        <input
          className="input input--sm"
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={value ?? ''}
          placeholder={placeholder}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (v === '') return onChange(null);
            const n = Number(v);
            if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
          }}
          data-testid={testid}
        />
        {unit && <em>{unit}</em>}
      </span>
    </label>
  );
}

const methodWord = (p: PlanSummary) => (p.optimal ? 'proven optimal' : p.method === 'heuristic-candidate-matching' ? 'heuristic, with bound' : 'exact, connectors added');

function CompareTable({ baseline, scenario, name }: { baseline: PlanSummary | { error: string }; scenario: PlanSummary | { error: string }; name: string }) {
  const ok = (x: PlanSummary | { error: string }): x is PlanSummary => !('error' in x);
  const rows: [string, (p: PlanSummary) => number, (v: number) => string][] = [
    ['Total distance', (p) => p.distanceM, fmtDist],
    ['Transit (deadhead)', (p) => p.transitM, fmtDist],
    ['Finish (makespan)', (p) => p.makespanS, fmtTime],
    ['Vehicle hours', (p) => p.vehicleSeconds, fmtTime],
  ];
  return (
    <table className="sc-table" data-testid="cov-comparison">
      <thead>
        <tr>
          <th />
          <th scope="col">Baseline</th>
          <th scope="col">{name}</th>
          <th scope="col">Change</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, get, f]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{ok(baseline) ? f(get(baseline)) : 'no plan'}</td>
            <td>{ok(scenario) ? f(get(scenario)) : 'no plan'}</td>
            <td>{ok(baseline) && ok(scenario) ? `${get(scenario) - get(baseline) >= 0 ? '+' : '−'}${f(Math.abs(get(scenario) - get(baseline)))}` : '–'}</td>
          </tr>
        ))}
        <tr>
          <th scope="row">Method</th>
          <td>{ok(baseline) ? methodWord(baseline) : baseline.error}</td>
          <td>{ok(scenario) ? methodWord(scenario) : scenario.error}</td>
          <td />
        </tr>
      </tbody>
    </table>
  );
}

export function CoveragePanel() {
  const city = useCity((s) => s.city)!;
  const pickTarget = useCity((s) => s.pickTarget);
  const cv = useCoverage();
  const activeScenario = useScenarios((s) => s.scenarios.find((x) => x.id === s.activeId));
  useScenarios((s) => s.activeId + s.scenarios.length); // re-render when the scenario changes (stale flag)
  const classes = useClasses(city);
  const [report, setReport] = useState(false);
  const pick = (t: 'zone-a' | 'depot' | 'dump') => useCity.getState().setPickTarget(pickTarget === t || (t === 'zone-a' && pickTarget === 'zone-b') ? null : t);
  const zoneW = cv.zone ? cv.zone.maxX - cv.zone.minX : 0;
  const zoneH = cv.zone ? cv.zone.maxY - cv.zone.minY : 0;
  const ready = cv.zone !== null && cv.depot !== null;
  const stale = cv.result !== null && cv.resultKey !== coverageKey(cv);
  const r = cv.result;
  const f = cv.fleet;
  const toggleClass = (c: string) => {
    const all = classes.map(([k]) => k);
    const cur = cv.roadClasses ?? all;
    const next = cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c];
    cv.setRoadClasses(next.length === all.length ? null : next);
  };

  return (
    <>
      <header>
        <p className="eyebrow">Coverage & fleet · street service</p>
        <h2>Plan the sweep.</h2>
        <p className="muted small">
          Draw a service zone on the real network, place the depot, and plan routes that cover every street in it. Exact methods are labelled exact; anything else is reported with a valid lower bound and its gap.
        </p>
      </header>

      <div className="cv-inputs">
        <div className="rl-end" data-testid="cov-zone-box">
          <div className="rl-end__body">
            <div className="rl-end__row">
              <span className="rl-end__label">Zone</span>
              <strong className="rl-end__value" data-testid="cov-zone">
                {cv.zone ? `${fmtDist(zoneW)} × ${fmtDist(zoneH)} · ${((zoneW * zoneH) / 1e6).toFixed(2)} km²` : pickTarget === 'zone-a' ? 'Click the first corner' : pickTarget === 'zone-b' ? 'Click the opposite corner' : 'Not drawn'}
              </strong>
              <button type="button" className={`btn btn--ghost btn--sm${pickTarget === 'zone-a' || pickTarget === 'zone-b' ? ' is-on' : ''}`} aria-pressed={pickTarget === 'zone-a' || pickTarget === 'zone-b'} onClick={() => pick('zone-a')} data-testid="cov-draw-zone">
                <Icon name="focus" size={13} /> Draw
              </button>
            </div>
          </div>
        </div>
        {(['depot', 'dump'] as const).map((w) => {
          const n = w === 'depot' ? cv.depot : cv.dump;
          return (
            <div key={w} className="rl-end">
              <div className="rl-end__body">
                <div className="rl-end__row">
                  <span className="rl-end__label">{w === 'depot' ? 'Depot' : 'Disposal'}</span>
                  <strong className="rl-end__value" data-testid={`cov-${w}`}>
                    {n !== null ? nodeLabel(city, n) : pickTarget === w ? 'Click an intersection' : w === 'depot' ? 'Not set' : 'None (optional)'}
                  </strong>
                  {w === 'dump' && n !== null && (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => cv.setDump(null)}>
                      Remove
                    </button>
                  )}
                  <button type="button" className={`btn btn--ghost btn--sm${pickTarget === w ? ' is-on' : ''}`} aria-pressed={pickTarget === w} onClick={() => pick(w)} data-testid={`pick-${w}`}>
                    <Icon name="focus" size={13} /> Pick
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <fieldset className="cv-group">
        <legend>Streets to service</legend>
        <div className="cv-classes">
          {classes.map(([c, len]) => {
            const on = cv.roadClasses === null || cv.roadClasses.includes(c);
            return (
              <label key={c} className={`rl-algo${on ? ' is-on' : ''}`}>
                <input type="checkbox" checked={on} onChange={() => toggleClass(c)} data-testid={`cov-class-${c}`} />
                {c.replace(/_/g, ' ')} <span className="faint">{fmtDist(len)}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="cv-group">
        <legend>One-way streets</legend>
        <div className="segmented segmented--sm" role="group" aria-label="Direction model">
          <button type="button" aria-pressed={cv.direction === 'directed'} onClick={() => cv.setDirection('directed')} data-testid="cov-dir-directed">
            Respect one-ways
          </button>
          <button type="button" aria-pressed={cv.direction === 'undirected'} onClick={() => cv.setDirection('undirected')} data-testid="cov-dir-undirected">
            Ignore one-ways
          </button>
        </div>
        <p className="faint small">
          {cv.direction === 'directed'
            ? 'Directed model: vehicles obey one-way streets, and two-way streets are serviced once in each direction (kerbside sweeping). Solved exactly by min-cost flow.'
            : 'Undirected relaxation (crews on foot): one-way restrictions are ignored and every street is serviced once. Wrong-way traversals are counted and shown.'}
        </p>
      </fieldset>

      <fieldset className="cv-group">
        <legend>Fleet</legend>
        <div className="cv-grid">
          <NumberField label="Vehicles" value={f.vehicles} onChange={(v) => cv.setFleet({ vehicles: v ?? 1 })} min={1} max={20} step={1} testid="cov-vehicles" />
          <NumberField label="Shift limit" value={f.shiftSeconds === null ? null : f.shiftSeconds / 3600} onChange={(v) => cv.setFleet({ shiftSeconds: v === null ? null : Math.round(v * 3600) })} min={0.25} max={24} step={0.25} placeholder="none" unit="h" testid="cov-shift" />
          <NumberField label="Service speed" value={f.serviceSpeedKmh} onChange={(v) => cv.setFleet({ serviceSpeedKmh: v ?? 8 })} min={1} max={60} step={0.5} unit="km/h" testid="cov-service-speed" />
          <NumberField label="Transit speed" value={f.deadheadSpeedKmh} onChange={(v) => cv.setFleet({ deadheadSpeedKmh: v ?? 20 })} min={1} max={80} step={0.5} unit="km/h" testid="cov-deadhead-speed" />
          <NumberField label="Capacity" value={f.capacity} onChange={(v) => cv.setFleet({ capacity: v })} min={1} max={1e6} step={1} placeholder="none" unit="units" testid="cov-capacity" />
          <NumberField label="Demand" value={f.demandPerKm} onChange={(v) => cv.setFleet({ demandPerKm: v ?? 0 })} min={0} max={1e5} step={0.1} unit="units/km" testid="cov-demand" />
          <NumberField label="Unloading" value={f.dumpSeconds / 60} onChange={(v) => cv.setFleet({ dumpSeconds: Math.round((v ?? 0) * 60) })} min={0} max={240} step={1} unit="min" testid="cov-dump-min" />
        </div>
        <div className="segmented segmented--sm" role="group" aria-label="Fleet objective">
          <button type="button" aria-pressed={f.objective === 'min-makespan'} onClick={() => cv.setFleet({ objective: 'min-makespan' })} data-testid="cov-obj-makespan">
            Finish soonest
          </button>
          <button type="button" aria-pressed={f.objective === 'min-total'} onClick={() => cv.setFleet({ objective: 'min-total' })} data-testid="cov-obj-total">
            Least total driving
          </button>
        </div>
        <p className="faint small">Speeds, capacity and demand are your planning inputs, not measured values.</p>
      </fieldset>

      <button type="button" className="btn btn--primary btn--spectral" disabled={!ready || cv.status === 'running'} onClick={() => void cv.run()} data-testid="cov-run">
        {cv.status === 'running' ? <span className="spinner" aria-hidden="true" /> : <Icon name="route" size={14} />} {cv.status === 'running' ? 'Planning…' : 'Plan coverage'}
      </button>
      {!ready && <p className="faint small">Draw a zone and pick a depot to plan.</p>}
      {cv.error && (
        <p className="notice notice--warn small" role="alert" data-testid="cov-error">
          {cv.error}
        </p>
      )}

      {r && (
        <section className="rl-results" aria-label="Coverage plan" data-testid="cov-results">
          {stale && (
            <p className="notice notice--warn small" data-testid="cov-stale">
              Inputs changed since this plan was computed. Plan again to update it.
            </p>
          )}
          <p className="cv-method" data-testid="cov-method">
            <strong>{METHOD_LABEL[r.method]}</strong>
            <span className={`cv-badge${r.optimal ? ' is-exact' : ''}`} data-testid="cov-optimal">
              {r.optimal ? 'Proven optimal' : r.gap !== null ? `Within ${pct(r.gap)} of a lower bound` : 'No optimality guarantee'}
            </span>
          </p>
          <p className="faint small" data-testid="cov-guarantee">
            {r.guarantee}
          </p>
          <div className="rl-summary">
            <div>
              <span>Total</span>
              <strong data-testid="cov-total">{fmtDist(r.totals.distanceM)}</strong>
            </div>
            <div>
              <span>Service</span>
              <strong>{fmtDist(r.totals.serviceM)}</strong>
            </div>
            <div>
              <span>Deadhead</span>
              <strong>{fmtDist(r.totals.deadheadM + r.totals.repeatM)}</strong>
            </div>
          </div>
          <dl className="cv-facts">
            <dt>Required streets</dt>
            <dd>
              {r.report.requiredSegments.toLocaleString('en-US')} segments · {r.report.requiredKm.toFixed(2)} km{r.report.onewayRequired ? ` · ${r.report.onewayRequired} one-way` : ''}
            </dd>
            <dt>Lower bound</dt>
            <dd data-testid="cov-lb">{r.lowerBoundM !== null ? `${fmtDist(r.lowerBoundM)} (${r.lowerBoundMethod})` : 'none'}</dd>
            <dt>Gap to bound</dt>
            <dd data-testid="cov-gap">{pct(r.gap)}</dd>
            {r.direction === 'undirected' && (
              <>
                <dt>Wrong-way traversals</dt>
                <dd data-testid="cov-wrongway">{r.wrongWayTraversals}</dd>
              </>
            )}
            {r.connectors.paths > 0 && (
              <>
                <dt>Connectors</dt>
                <dd>
                  {r.connectors.paths} path{r.connectors.paths === 1 ? '' : 's'} ({fmtDist(r.connectors.distance)}) join {r.connectors.components} separate street groups
                </dd>
              </>
            )}
            {r.excluded.unserviceable.length > 0 && (
              <>
                <dt>Not serviceable</dt>
                <dd>
                  {r.excluded.unserviceable.length} street{r.excluded.unserviceable.length === 1 ? '' : 's'}: {r.excluded.reason}
                </dd>
              </>
            )}
            {r.report.cutOffSegments.length > 0 && (
              <>
                <dt>Cut off by closures</dt>
                <dd>{r.report.cutOffSegments.length} segments</dd>
              </>
            )}
            <dt>Solve time</dt>
            <dd>{Math.round(r.timingsMs.total ?? 0)} ms{r.fleet ? ` + fleet ${Math.round(r.fleet.timingsMs.total)} ms` : ''}</dd>
          </dl>

          {r.fleet && (
            <>
              <p className="faint small" data-testid="cov-fleet-guarantee">
                {r.fleet.guarantee}
              </p>
              <dl className="cv-facts">
                <dt>Finish (makespan)</dt>
                <dd data-testid="cov-makespan">
                  {fmtTime(r.fleet.totals.makespanSeconds)} · bound {fmtTime(r.fleet.lowerBounds.makespanSeconds.value)} · gap {pct(r.fleet.gaps.makespan)}
                </dd>
                <dt>Vehicles used</dt>
                <dd>
                  {r.fleet.totals.vehiclesUsed} of {f.vehicles}
                  {r.fleet.lowerBounds.vehiclesByShift !== null ? ` · at least ${r.fleet.lowerBounds.vehiclesByShift} needed for the shift limit` : ''}
                  {r.fleet.lowerBounds.vehiclesByCapacity !== null ? ` · at least ${r.fleet.lowerBounds.vehiclesByCapacity} by capacity` : ''}
                </dd>
                <dt>Feasible</dt>
                <dd data-testid="cov-feasible">{r.fleet.feasibility.ok ? 'yes' : `no: ${r.fleet.feasibility.issues.join('; ')}`}</dd>
              </dl>
            </>
          )}

          <table className="sc-table" data-testid="cov-vehicles-table">
            <thead>
              <tr>
                <th scope="col">Vehicle</th>
                <th scope="col">Distance</th>
                <th scope="col">Time</th>
                <th scope="col">Trips</th>
              </tr>
            </thead>
            <tbody>
              {r.routes.map((v, i) => (
                <tr key={v.vehicle} data-testid={`cov-vehicle-${i}`}>
                  <th scope="row">
                    <i className="cv-swatch" style={{ background: VEHICLE_COLORS[i % VEHICLE_COLORS.length] }} aria-hidden="true" /> {i + 1}
                    {!v.feasible.shift || !v.feasible.capacity ? <span className="sc-tag sc-tag--closed">over limit</span> : null}
                  </th>
                  <td>{fmtDist(v.distanceM)}</td>
                  <td>{fmtTime(v.seconds)}</td>
                  <td>{v.trips}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <fieldset className="cv-group" data-testid="cov-costs">
            <legend>Cost estimate · from your assumptions</legend>
            <div className="cv-grid">
              <NumberField label="Fuel, servicing" value={cv.costs.fuelServiceLPer100km} onChange={(v) => cv.setCosts({ fuelServiceLPer100km: v })} min={0} max={500} step={0.5} placeholder="enter" unit="L/100 km" testid="cost-fuel-service" />
              <NumberField label="Fuel, transit" value={cv.costs.fuelTransitLPer100km} onChange={(v) => cv.setCosts({ fuelTransitLPer100km: v })} min={0} max={500} step={0.5} placeholder="enter" unit="L/100 km" testid="cost-fuel-transit" />
              <NumberField label="Fuel price" value={cv.costs.fuelPricePerL} onChange={(v) => cv.setCosts({ fuelPricePerL: v })} min={0} max={1000} step={0.5} placeholder="enter" unit="₹/L" testid="cost-fuel-price" />
              <NumberField label="Crew per vehicle" value={cv.costs.crewPerVehicle} onChange={(v) => cv.setCosts({ crewPerVehicle: v })} min={0} max={20} step={1} placeholder="enter" testid="cost-crew" />
              <NumberField label="Wage" value={cv.costs.wagePerHour} onChange={(v) => cv.setCosts({ wagePerHour: v })} min={0} max={10000} step={1} placeholder="enter" unit="₹/h" testid="cost-wage" />
              <NumberField label="CO₂ factor" value={cv.costs.co2KgPerL} onChange={(v) => cv.setCosts({ co2KgPerL: v ?? 2.68 })} min={0} max={10} step={0.01} unit="kg/L" testid="cost-co2" />
            </div>
            {(() => {
              const e = estimateCost({ serviceM: r.totals.serviceM, transitM: r.totals.deadheadM + r.totals.repeatM, vehicleSeconds: r.routes.reduce((a, v) => a + v.seconds, 0) }, cv.costs);
              return (
                <dl className="cv-facts" data-testid="cost-results">
                  <dt>Fuel</dt>
                  <dd data-testid="cost-fuel">{e.fuelL === null ? 'enter both fuel rates' : `${e.fuelL.toFixed(1)} L`}</dd>
                  <dt>CO₂ (tailpipe)</dt>
                  <dd data-testid="cost-co2-kg">{e.co2Kg === null ? '–' : `${e.co2Kg.toFixed(1)} kg`}</dd>
                  <dt>Fuel cost</dt>
                  <dd>{inr(e.fuelCost)}</dd>
                  <dt>Labour</dt>
                  <dd>{inr(e.labourCost)}</dd>
                  <dt>Total</dt>
                  <dd data-testid="cost-total">{inr(e.totalCost)}</dd>
                </dl>
              );
            })()}
            <p className="faint small">Estimates from the numbers you enter, applied to this plan's distances and vehicle hours. Nothing here is a measured municipal figure. The 2.68 kg/L default is the usual combustion factor for diesel; change it for other fuels.</p>
          </fieldset>

          <section className="sc-compare" aria-label="Scenario impact on coverage">
            <h3>Scenario impact</h3>
            {!activeScenario || activeScenario.id === 'baseline' ? (
              <p className="faint small">Create a scenario (closures, direction changes) in the Scenarios tab to compare this plan against the baseline network.</p>
            ) : (
              <>
                <p className="faint small">
                  Same zone, depot and fleet, planned on the baseline and on <strong>{activeScenario.name}</strong>.
                </p>
                <button type="button" className="btn btn--primary btn--sm" disabled={cv.comparing} onClick={() => void cv.compare()} data-testid="cov-compare">
                  {cv.comparing ? <span className="spinner" aria-hidden="true" /> : null} Compare with baseline
                </button>
                {cv.comparison && cv.comparison.key === coverageKey(cv) && (
                  <CompareTable baseline={cv.comparison.baseline} scenario={cv.comparison.scenario} name={activeScenario.name} />
                )}
              </>
            )}
          </section>

          <button type="button" className="btn btn--quiet btn--sm" onClick={() => setReport(true)} data-testid="cov-open-report">
            <Icon name="table" size={13} /> Printable report
          </button>
          {report && <CoverageReport onClose={() => setReport(false)} />}

          <details className="cv-checks" data-testid="cov-checks">
            <summary>
              Independent checks: {[...r.checks, ...(r.fleet?.checks ?? [])].filter((c) => c.passed).length} of {r.checks.length + (r.fleet?.checks.length ?? 0)} passed
            </summary>
            <ul>
              {[...r.checks, ...(r.fleet?.checks ?? [])].map((c, i) => (
                <li key={`${c.id}-${i}`} className={c.passed ? 'is-ok' : 'is-bad'}>
                  <strong>{c.passed ? '✓' : '✗'} {c.label}</strong> <span className="faint small">{c.detail}</span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </>
  );
}
