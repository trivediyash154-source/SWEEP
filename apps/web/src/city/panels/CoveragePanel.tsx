import { useEffect, useMemo, useState } from 'react';
import type { CityModel } from '@sweep/engine';
import { Icon } from '../../components/Icon';
import { useCity } from '../store';
import { coverageKey, effectiveInputs, summarise, useCoverage, type PlanSummary } from '../coverageStore';
import { BASELINE, useScenarios, type Scenario } from '../scenario';
import { fmtDist, fmtTime, nodeLabel } from './RouteLab';
import { estimateCost, type CostAssumptions } from '../costModel';
import { CoverageReport } from './CoverageReport';
import { describeZone, drawingPrompt, type ZoneShape } from '../zoneShape';
import { plansToCsv, plansToGpx } from '../coverageExport';
import { useShift } from '../shift';
import { downloadText, safeFileName } from '../../lib/storage';

const SHAPES: [ZoneShape, string][] = [
  ['rect', 'Rectangle'],
  ['circle', 'Circle'],
  ['polygon', 'Outline'],
];

/** Polygon drawing keys: Enter closes the outline, Backspace removes the last point (not while typing in a field). */
function usePolygonKeys(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const cv = useCoverage.getState();
      if (e.key === 'Enter') {
        e.preventDefault();
        if (cv.finishZone()) useCity.getState().setPickTarget(null);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        cv.undoZonePoint();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);
}

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

export function NumberField({ label, value, onChange, min, max, step, placeholder, testid, unit }: { label: string; value: number | null; onChange: (v: number | null) => void; min: number; max: number; step: number; placeholder?: string; testid: string; unit?: string }) {
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

const COST_LABEL: Record<keyof CostAssumptions, string> = {
  fuelServiceLPer100km: 'fuel while servicing',
  fuelTransitLPer100km: 'fuel in transit',
  fuelPricePerL: 'fuel price',
  crewPerVehicle: 'crew per vehicle',
  wagePerHour: 'wage',
  co2KgPerL: 'CO₂ factor',
};

/** Plain-language list of a scenario's plan overrides. */
export function describeOverrides(city: CityModel, s: Scenario): string[] {
  const p = s.plan;
  if (!p) return [];
  const out: string[] = [];
  if (p.depot !== undefined) out.push(`depot at ${nodeLabel(city, p.depot)}`);
  if (p.vehicles !== undefined) out.push(`${p.vehicles} vehicle${p.vehicles === 1 ? '' : 's'}`);
  if (p.shiftSeconds !== undefined) out.push(p.shiftSeconds === null ? 'no shift limit' : `shift limit ${fmtTime(p.shiftSeconds)}`);
  for (const [k, v] of Object.entries(p.costs ?? {}) as [keyof CostAssumptions, number | null][]) out.push(`${COST_LABEL[k]} ${v ?? '–'}`);
  return out;
}

const num1 = (x: number) => x.toFixed(1);
const signed = (d: number, f: (v: number) => string) => `${d >= 0 ? '+' : '−'}${f(Math.abs(d))}`;

function CompareTable({ baseline, scenario, name, costs }: { baseline: PlanSummary | { error: string }; scenario: PlanSummary | { error: string }; name: string; costs: { baseline: CostAssumptions; scenario: CostAssumptions } }) {
  const ok = (x: PlanSummary | { error: string }): x is PlanSummary => !('error' in x);
  const est = (p: PlanSummary, a: CostAssumptions) => estimateCost({ serviceM: p.serviceM, transitM: p.transitM, vehicleSeconds: p.vehicleSeconds }, a);
  // Rows: label, value (null = cannot be computed from the inputs given), format, test id.
  const rows: [string, (p: PlanSummary, a: CostAssumptions) => number | null, (v: number) => string, string][] = [
    ['Total distance', (p) => p.distanceM, fmtDist, 'distance'],
    ['Transit (deadhead)', (p) => p.transitM, fmtDist, 'transit'],
    ['Finish (makespan)', (p) => p.makespanS, fmtTime, 'makespan'],
    ['Vehicle hours', (p) => p.vehicleSeconds, fmtTime, 'hours'],
    ['Vehicles used', (p) => p.vehiclesUsed, (v) => String(v), 'vehicles'],
    ['Fuel (estimate)', (p, a) => est(p, a).fuelL, (v) => `${num1(v)} L`, 'fuel'],
    ['CO₂ (estimate)', (p, a) => est(p, a).co2Kg, (v) => `${num1(v)} kg`, 'co2'],
    ['Cost (estimate)', (p, a) => est(p, a).totalCost, inr, 'cost'],
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
        {rows.map(([label, get, f, id]) => {
          const b = ok(baseline) ? get(baseline, costs.baseline) : null;
          const s = ok(scenario) ? get(scenario, costs.scenario) : null;
          return (
            <tr key={label} data-testid={`cmp-${id}`}>
              <th scope="row">{label}</th>
              <td>{!ok(baseline) ? 'no plan' : b === null ? '–' : f(b)}</td>
              <td>{!ok(scenario) ? 'no plan' : s === null ? '–' : f(s)}</td>
              <td>{b !== null && s !== null ? signed(s - b, f) : '–'}</td>
            </tr>
          );
        })}
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
  const activeScenario = useScenarios((s) => s.scenarios.find((x) => x.id === s.activeId)) ?? BASELINE;
  const eff = effectiveInputs(cv, activeScenario);
  const overrides = describeOverrides(city, activeScenario);
  const classes = useClasses(city);
  const [report, setReport] = useState(false);
  const drawing = pickTarget === 'zone';
  const pick = (t: 'zone' | 'depot' | 'dump') => {
    if (t === 'zone' || drawing) cv.cancelZone();
    useCity.getState().setPickTarget(pickTarget === t ? null : t);
  };
  // Leaving the drawing mode any other way (Escape, another pick) drops the unfinished shape.
  useEffect(() => {
    if (!drawing && useCoverage.getState().draft.length) useCoverage.getState().cancelZone();
  }, [drawing]);
  usePolygonKeys(drawing && cv.zoneShape === 'polygon');
  const ready = cv.zone !== null && eff.depot !== null;
  const stale = cv.result !== null && cv.resultKey !== coverageKey(cv);
  const r = cv.result;
  const sum = r ? summarise(r) : null;
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
        <div className="rl-end rl-end--plain" data-testid="cov-zone-box">
          <div className="rl-end__body">
            <div className="rl-end__row">
              <span className="rl-end__label">Zone</span>
              <strong className="rl-end__value" data-testid="cov-zone" title={cv.zone && !drawing ? describeZone(cv.zone) : undefined}>
                {drawing ? drawingPrompt(cv.zoneShape, cv.draft.length) : cv.zone ? describeZone(cv.zone) : 'Not drawn'}
              </strong>
              <button type="button" className={`btn btn--ghost btn--sm${drawing ? ' is-on' : ''}`} aria-pressed={drawing} onClick={() => pick('zone')} data-testid="cov-draw-zone">
                <Icon name="focus" size={13} /> {drawing ? 'Stop' : 'Draw'}
              </button>
            </div>
            <div className="segmented segmented--sm cv-shapes" role="group" aria-label="Zone shape">
              {SHAPES.map(([k, label]) => (
                <button key={k} type="button" aria-pressed={cv.zoneShape === k} onClick={() => cv.setZoneShape(k)} data-testid={`cov-shape-${k}`}>
                  {label}
                </button>
              ))}
            </div>
            {drawing && cv.zoneShape === 'polygon' && cv.draft.length > 0 && (
              <div className="cv-zone-tools">
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => cv.undoZonePoint()} data-testid="cov-zone-undo">
                  Undo point
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={cv.draft.length < 3}
                  onClick={() => {
                    if (cv.finishZone()) useCity.getState().setPickTarget(null);
                  }}
                  data-testid="cov-zone-finish"
                >
                  Finish outline
                </button>
              </div>
            )}
            {cv.zoneHint && (
              <p className="notice notice--warn small" role="status" data-testid="cov-zone-hint">
                {cv.zoneHint}
              </p>
            )}
          </div>
        </div>
        {(['depot', 'dump'] as const).map((w) => {
          const n = w === 'depot' ? cv.depot : cv.dump;
          return (
            <div key={w} className="rl-end rl-end--plain">
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

      {overrides.length > 0 && (
        <p className="notice small" data-testid="cov-overrides">
          Scenario <strong>{activeScenario.name}</strong> changes the operation: {overrides.join(' · ')}. Plans use these values; the fields above stay as the baseline operation.
        </p>
      )}

      <button type="button" className="btn btn--primary btn--spectral" disabled={!ready || drawing || cv.status === 'running'} onClick={() => void cv.run()} data-testid="cov-run">
        {cv.status === 'running' ? <span className="spinner" aria-hidden="true" /> : <Icon name="route" size={14} />} {cv.status === 'running' ? 'Planning…' : 'Plan coverage'}
      </button>
      {!ready && <p className="faint small">Draw a zone (rectangle, circle or free outline) and pick a depot to plan. Every street whose midpoint lies inside the zone is serviced.</p>}
      {ready && drawing && <p className="faint small">Finish or stop drawing the zone to plan.</p>}
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
              <span>{r.fleet ? 'Total, all vehicles' : 'Total'}</span>
              <strong data-testid="cov-total">{fmtDist(sum!.distanceM)}</strong>
            </div>
            <div>
              <span>Service</span>
              <strong>{fmtDist(sum!.serviceM)}</strong>
            </div>
            <div>
              <span>Deadhead</span>
              <strong data-testid="cov-transit">{fmtDist(sum!.transitM)}</strong>
            </div>
          </div>
          <dl className="cv-facts">
            <dt>Required streets</dt>
            <dd>
              {r.report.requiredSegments.toLocaleString('en-US')} segments · {r.report.requiredKm.toFixed(2)} km{r.report.onewayRequired ? ` · ${r.report.onewayRequired} one-way` : ''}
            </dd>
            {r.fleet && (
              <>
                <dt>Single closed route</dt>
                <dd data-testid="cov-single">{fmtDist(r.totals.distanceM)}, which the fleet plan splits into vehicle routes from the depot</dd>
              </>
            )}
            <dt>Lower bound</dt>
            <dd data-testid="cov-lb">{r.lowerBoundM !== null ? `${fmtDist(r.lowerBoundM)} (${r.lowerBoundMethod})` : 'none'}</dd>
            <dt>{r.fleet ? 'Gap, single route' : 'Gap to bound'}</dt>
            <dd data-testid="cov-gap">{pct(r.gap)}</dd>
            {r.fleet && (
              <>
                <dt>Gap, fleet total</dt>
                <dd data-testid="cov-fleet-gap">
                  {pct(r.fleet.gaps.totalDistance)} against {fmtDist(r.fleet.lowerBounds.totalDistance.value)}
                </dd>
              </>
            )}
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
              {r.fleet.totals.vehiclesUsed > eff.fleet.vehicles && (
                <p className="notice notice--warn small" role="alert" data-testid="cov-overfleet">
                  {eff.fleet.vehicles} vehicle{eff.fleet.vehicles === 1 ? '' : 's'} cannot do this work within the limits. The plan below uses {r.fleet.totals.vehiclesUsed} routes, each within the shift
                  {r.fleet.lowerBounds.vehiclesByShift !== null ? `; any plan needs at least ${r.fleet.lowerBounds.vehiclesByShift} vehicles for this shift` : ''}. Add vehicles or lengthen the shift.
                </p>
              )}
              <dl className="cv-facts">
                <dt>Finish (makespan)</dt>
                <dd data-testid="cov-makespan">
                  {r.fleet.totals.vehiclesUsed > eff.fleet.vehicles
                    ? `${fmtTime(r.fleet.totals.makespanSeconds)} with ${r.fleet.totals.vehiclesUsed} routes · with ${eff.fleet.vehicles} vehicle${eff.fleet.vehicles === 1 ? '' : 's'}, no plan finishes before ${fmtTime(r.fleet.lowerBounds.makespanSeconds.value)} (lower bound)`
                    : `${fmtTime(r.fleet.totals.makespanSeconds)} · bound ${fmtTime(r.fleet.lowerBounds.makespanSeconds.value)} · gap ${pct(r.fleet.gaps.makespan)}`}
                </dd>
                <dt>Vehicles used</dt>
                <dd data-testid="cov-vehicles-used">
                  {r.fleet.totals.vehiclesUsed > eff.fleet.vehicles ? `${r.fleet.totals.vehiclesUsed} routes needed, ${eff.fleet.vehicles} available` : `${r.fleet.totals.vehiclesUsed} of ${eff.fleet.vehicles}`}
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
              const e = estimateCost(sum!, eff.costs);
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
            {activeScenario.id === 'baseline' ? (
              <p className="faint small">Create a scenario in the Scenarios tab (closures, direction changes, another depot, fleet size or cost assumptions) to compare this plan against the baseline.</p>
            ) : (
              <>
                <p className="faint small">
                  Same zone and streets. Baseline: the inputs above on the mapped network. <strong>{activeScenario.name}</strong>: its network changes{overrides.length ? ` and ${overrides.join(', ')}` : ''}.
                </p>
                <button type="button" className="btn btn--primary btn--sm" disabled={cv.comparing} onClick={() => void cv.compare()} data-testid="cov-compare">
                  {cv.comparing ? <span className="spinner" aria-hidden="true" /> : null} Compare with baseline
                </button>
                {cv.comparison && cv.comparison.key === coverageKey(cv) && (
                  <CompareTable baseline={cv.comparison.baseline} scenario={cv.comparison.scenario} name={activeScenario.name} costs={{ baseline: cv.costs, scenario: eff.costs }} />
                )}
              </>
            )}
          </section>

          <div className="cv-exports">
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => setReport(true)} data-testid="cov-open-report">
              <Icon name="table" size={13} /> Printable report
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => {
                const name = `${city.name} · coverage plan`;
                const desc = `${METHOD_LABEL[r.method]}; ${r.routes.filter((v) => v.arcs.length).length} vehicle route(s); ${describeZone(cv.zone!)}. Generated by SWEEP from OpenStreetMap data.`;
                downloadText(`${safeFileName(`${city.id}-coverage`)}.gpx`, plansToGpx(city, r.routes, { name, description: desc, time: new Date() }), 'application/gpx+xml');
              }}
              data-testid="cov-export-gpx"
            >
              <Icon name="download" size={13} /> GPX tracks
            </button>
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => downloadText(`${safeFileName(`${city.id}-coverage-steps`)}.csv`, plansToCsv(city, r.routes, eff.fleet, useShift.getState().startOfDay), 'text/csv')}
              data-testid="cov-export-csv"
            >
              <Icon name="download" size={13} /> Step list (CSV)
            </button>
          </div>
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
