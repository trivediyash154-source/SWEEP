import { useEffect, useState } from 'react';
import { isOneway, type RoutingResult } from '@sweep/engine';
import { useWorkspace, routingOf } from '../state/workspace';
import { formatDistance, formatNumber, formatPercent } from '../lib/format';
import { fleetSweep, routeLocal, type FleetSweepPoint } from '../lib/engineClient';
import { Icon } from '../components/Icon';
import { useRoute } from './useRouteData';

interface Bar {
  id: string;
  label: string;
  value: number | null;
  valid: boolean;
  note: string;
  kind: 'optimal' | 'baseline' | 'bound';
}

function CompareBars({ bars }: { bars: Bar[] }) {
  const max = Math.max(1, ...bars.map((b) => b.value ?? 0));
  const opt = bars.find((b) => b.kind === 'optimal')?.value ?? null;
  return (
    <div className="hbars" role="list">
      {bars.map((b) => (
        <div key={b.id} className={`hbar hbar--${b.kind}`} role="listitem" data-testid={`compare-${b.id}`}>
          <div className="hbar__label">
            <strong>{b.label}</strong>
            <span className="small muted">{b.note}</span>
          </div>
          <div className="hbar__track">
            <span className="hbar__fill" style={{ width: `${b.value === null ? 0 : (b.value / max) * 100}%` }} />
          </div>
          <div className="hbar__value mono">
            {b.value === null ? 'n/a' : formatDistance(b.value)}
            {opt !== null && b.value !== null && b.kind === 'baseline' && opt > 0 ? <span className="faint"> +{formatPercent((b.value - opt) / opt)}</span> : null}
            {!b.valid ? <span className="chip">not a route</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function FleetChart({ points, single }: { points: FleetSweepPoint[]; single: number }) {
  const ok = points.filter((p) => p.ok);
  if (ok.length === 0) return <p className="muted small">{points[0]?.issue ?? 'No fleet results.'}</p>;
  const W = 520;
  const H = 210;
  const pad = { l: 64, r: 16, t: 14, b: 34 };
  const maxY = Math.max(...ok.map((p) => p.total ?? 0), single);
  const xs = (k: number) => pad.l + ((k - 1) / Math.max(1, ok.length - 1)) * (W - pad.l - pad.r);
  const ys = (v: number) => H - pad.b - (v / maxY) * (H - pad.t - pad.b);
  const path = (sel: (p: FleetSweepPoint) => number) => ok.map((p, i) => `${i === 0 ? 'M' : 'L'}${xs(p.k).toFixed(1)},${ys(sel(p)).toFixed(1)}`).join('');
  return (
    <figure className="fleet-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Longest route and total fleet distance by number of vehicles">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={ys(maxY * f)} y2={ys(maxY * f)} className="grid-line" />
            <text x={pad.l - 8} y={ys(maxY * f) + 4} textAnchor="end" className="axis-label">{formatDistance(maxY * f)}</text>
          </g>
        ))}
        {ok.map((p) => (
          <text key={p.k} x={xs(p.k)} y={H - 12} textAnchor="middle" className="axis-label">{p.k}</text>
        ))}
        <path d={path((p) => p.lowerBound ?? 0)} className="series series--bound" />
        <path d={path((p) => p.total ?? 0)} className="series series--total" />
        <path d={path((p) => p.makespan ?? 0)} className="series series--makespan" />
        {ok.map((p) => (
          <g key={`d${p.k}`}>
            <circle cx={xs(p.k)} cy={ys(p.makespan ?? 0)} r={3.5} className="dot dot--makespan" />
            <circle cx={xs(p.k)} cy={ys(p.total ?? 0)} r={3.5} className="dot dot--total" />
          </g>
        ))}
      </svg>
      <figcaption className="legend-inline small">
        <i className="lg lg--makespan" /> longest route <i className="lg lg--total" /> total fleet distance <i className="lg lg--bound" /> lower bound on the longest route · x: vehicles
      </figcaption>
    </figure>
  );
}

export function LabSection() {
  const { graph, fresh } = useRoute();
  const result = useWorkspace((s) => s.result);
  const settings = useWorkspace((s) => s.resultSettings);
  const [relax, setRelax] = useState<{ undirected: RoutingResult | null; directed: RoutingResult | null; busy: boolean; error: string | null }>({ undirected: null, directed: null, busy: false, error: null });
  const [sweep, setSweep] = useState<{ points: FleetSweepPoint[] | null; busy: boolean }>({ points: null, busy: false });
  const hasOneway = graph.edges.some(isOneway);

  useEffect(() => {
    setRelax({ undirected: null, directed: null, busy: false, error: null });
    setSweep({ points: null, busy: false });
  }, [result]);

  if (!result || !fresh) {
    return (
      <section id="surface-laboratory" className="surface" aria-labelledby="lab-h">
        <header className="surface__head">
          <p className="eyebrow">E · Route-performance laboratory</p>
          <h2 id="lab-h" className="dim-title">Compare strategies on real numbers.</h2>
        </header>
        <p className="muted">Optimise the network to compare strategies.</p>
      </section>
    );
  }
  const base = result.route;
  const bars: Bar[] = [
    { id: 'optimal', label: result.mode === 'directed' ? 'Exact directed optimum' : 'Exact optimum', value: base.totalDistance, valid: true, note: result.algorithm.optimal ? 'Certified by this run' : 'Not certified', kind: 'optimal' },
    ...result.baselines.map<Bar>((b) => ({
      id: b.id,
      label: b.label,
      value: b.total,
      valid: b.isValidRoute,
      note: b.description,
      kind: b.id === 'lower-bound' ? 'bound' : 'baseline',
    })),
  ];
  const service = base.steps.filter((s) => s.kind === 'service').reduce((x, s) => x + s.weight, 0);
  const repeatD = base.steps.filter((s) => s.kind === 'repeat').reduce((x, s) => x + s.weight, 0);
  const deadD = base.steps.filter((s) => s.kind === 'deadhead').reduce((x, s) => x + s.weight, 0);
  const addedCopies = Object.values(result.mode === 'directed' ? result.augmentation.addedCopies : result.augmentation.addedCopies).reduce((a, b) => a + b, 0);
  const requiredCount = result.mode === 'directed' ? result.input.requiredArcCount : result.input.requiredEdgeCount;
  const runRelax = async () => {
    setRelax((r) => ({ ...r, busy: true, error: null }));
    try {
      const s = routingOf(graph);
      const [u, d] = await Promise.all([
        routeLocal(graph, graph.depotId ?? null, { ...s, mode: 'undirected', ignoreOneway: true, vehicles: 1 }),
        routeLocal(graph, graph.depotId ?? null, { ...s, mode: 'directed', vehicles: 1 }),
      ]);
      setRelax({ undirected: u, directed: d, busy: false, error: null });
    } catch (e) {
      setRelax((r) => ({ ...r, busy: false, error: (e as Error).message }));
    }
  };
  const runSweep = async () => {
    setSweep({ points: null, busy: true });
    const s = settings ?? routingOf(graph);
    const pts = await fleetSweep(graph, result.input.depotId, { ...s, objective: 'balance', maxRouteLength: null }, result, [1, 2, 3, 4, 5, 6]);
    setSweep({ points: pts, busy: false });
  };
  return (
    <section id="surface-laboratory" className="surface" aria-labelledby="lab-h">
      <header className="surface__head">
        <p className="eyebrow">E · Route-performance laboratory</p>
        <h2 id="lab-h" className="dim-title">Compare strategies on real numbers.</h2>
        <p className="surface__lede muted">Same network, same start, same required streets. Each alternative below is computed, not estimated; bars marked “not a route” are bounds, not drivable plans.</p>
      </header>
      <div className="lab-grid">
        <article className="lab-card lab-card--wide">
          <h3 className="panel-title">Strategy comparison</h3>
          <CompareBars bars={bars} />
        </article>
        <article className="lab-card">
          <h3 className="panel-title">Original vs augmented graph</h3>
          <dl className="ab-grid">
            <div><dt /><dd className="faint small">Original</dd><dd className="faint small">Augmented</dd></div>
            <div><dt>{result.mode === 'directed' ? 'Required arcs' : 'Required streets'}</dt><dd className="mono">{formatNumber(requiredCount)}</dd><dd className="mono">{formatNumber(requiredCount + addedCopies)}</dd></div>
            <div>
              <dt>{result.mode === 'directed' ? 'Imbalanced intersections' : 'Odd intersections'}</dt>
              <dd className="mono">{formatNumber(result.mode === 'directed' ? result.imbalancedVertexIds.length : result.oddVertexIds.length)}</dd>
              <dd className="mono">0</dd>
            </div>
            <div><dt>Distance</dt><dd className="mono">{formatDistance(base.requiredDistance)}</dd><dd className="mono">{formatDistance(base.totalDistance)}</dd></div>
            <div><dt>Euler circuit</dt><dd className="mono">no</dd><dd className="mono">yes</dd></div>
          </dl>
        </article>
        <article className="lab-card">
          <h3 className="panel-title">Required vs total distance</h3>
          <div className="stack-bar" role="img" aria-label={`Service ${formatDistance(service)}, repeated ${formatDistance(repeatD)}, deadhead ${formatDistance(deadD)}`}>
            <span className="stack-bar__service" style={{ flexGrow: service }} />
            <span className="stack-bar__repeat" style={{ flexGrow: repeatD }} />
            <span className="stack-bar__dead" style={{ flexGrow: deadD }} />
          </div>
          <dl className="readout-list readout-list--compact">
            <div><dt><i className="lg lg--service" /> Service</dt><dd className="num">{formatDistance(service)}</dd></div>
            <div><dt><i className="lg lg--repeat" /> Repeated required</dt><dd className="num">{formatDistance(repeatD)}</dd></div>
            <div><dt><i className="lg lg--deadhead" /> Deadhead</dt><dd className="num">{formatDistance(deadD)}</dd></div>
            <div><dt>Efficiency</dt><dd className="num">{formatPercent(base.totalDistance > 0 ? service / base.totalDistance : 0)}</dd></div>
          </dl>
        </article>
        {hasOneway && (
          <article className="lab-card lab-card--wide">
            <h3 className="panel-title">One-way rules: directed solution vs two-way relaxation</h3>
            <p className="small muted">Treating one-way streets as two-way (the undirected relaxation) gives a shorter number but may drive against traffic. Both runs use this browser's engine on the same network.</p>
            {relax.undirected || relax.directed ? (
              <dl className="ab-grid ab-grid--3">
                <div><dt /><dd className="faint small">Two-way relaxation</dd><dd className="faint small">Directed (legal)</dd></div>
                <div>
                  <dt>Total</dt>
                  <dd className="mono">{relax.undirected?.ok ? formatDistance(relax.undirected.single.route.totalDistance) : 'infeasible'}</dd>
                  <dd className="mono">{relax.directed?.ok ? formatDistance(relax.directed.single.route.totalDistance) : 'infeasible'}</dd>
                </div>
                <div>
                  <dt>Wrong-way traversals</dt>
                  <dd className="mono num--repeat" data-testid="relax-wrongway">{relax.undirected?.ok ? formatNumber(relax.undirected.single.route.wrongWayTraversals) : '—'}</dd>
                  <dd className="mono">0</dd>
                </div>
                <div>
                  <dt>Legal route</dt>
                  <dd className="mono">{relax.undirected?.ok ? (relax.undirected.single.route.wrongWayTraversals === 0 ? 'yes' : 'no') : '—'}</dd>
                  <dd className="mono">{relax.directed?.ok ? 'yes' : '—'}</dd>
                </div>
              </dl>
            ) : null}
            {!relax.directed?.ok && relax.directed && <p className="notice notice--warn small">{relax.directed.validation.issues.find((i) => i.severity === 'error')?.message}</p>}
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => void runRelax()} disabled={relax.busy} data-testid="run-relax">
              {relax.busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="flask" size={14} />} {relax.undirected ? 'Recompute' : 'Compute comparison'}
            </button>
          </article>
        )}
        <article className="lab-card lab-card--wide">
          <h3 className="panel-title">Fleet size: longest route vs total distance</h3>
          <p className="small muted">
            Splitting the certified single route among more vehicles shortens the longest route but adds approach and return driving, so the fleet's total distance never falls below the single route ({formatDistance(base.totalDistance)}).{' '}
            {result.mode === 'directed' ? 'For one-way networks the split is a heuristic without a proven ratio.' : 'The longest route is within (2 − 1/k) of the optimum (Frederickson–Hecht–Kim).'}
          </p>
          {sweep.points && <FleetChart points={sweep.points} single={base.totalDistance} />}
          {sweep.points && (
            <table className="table table--compact">
              <thead><tr><th>Vehicles</th><th>Longest route</th><th>Total</th><th>Lower bound</th><th>Guarantee</th></tr></thead>
              <tbody>
                {sweep.points.map((p) => (
                  <tr key={p.k}>
                    <td className="mono">{p.k}</td>
                    <td className="mono">{p.ok ? formatDistance(p.makespan!) : '—'}</td>
                    <td className="mono">{p.ok ? formatDistance(p.total!) : '—'}</td>
                    <td className="mono">{p.ok ? formatDistance(p.lowerBound!) : '—'}</td>
                    <td className="mono">{p.ok ? (p.ratioBound ? `≤ ${p.ratioBound.toFixed(2)}×` : p.k === 1 ? 'exact' : 'heuristic') : p.issue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => void runSweep()} disabled={sweep.busy} data-testid="run-sweep">
            {sweep.busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="truck" size={14} />} {sweep.points ? 'Recompute' : 'Compute 1–6 vehicles'}
          </button>
        </article>
      </div>
    </section>
  );
}
