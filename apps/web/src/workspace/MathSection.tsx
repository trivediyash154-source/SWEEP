import { useMemo } from 'react';
import type { DirectedOptimizationRecord, OptimizationRecord } from '@sweep/engine';
import { useWorkspace } from '../state/workspace';
import { useReducedMotion } from '../state/prefs';
import { formatDistance, formatNumber } from '../lib/format';
import { Icon } from '../components/Icon';
import { RouteProjection } from './RouteProjection';
import { routeClock } from './routeClock';
import { useRoute } from './useRouteData';
import type { StepId } from '../lib/analysis';

function Bars({ data, label, oddKey }: { data: Array<{ k: string; v: number; odd?: boolean }>; label: string; oddKey?: string }) {
  const max = Math.max(1, ...data.map((d) => d.v));
  return (
    <figure className="bars-fig">
      <figcaption className="small muted">{label}</figcaption>
      <div className="vbars" role="list">
        {data.map((d) => (
          <div key={d.k} className={`vbar${d.odd ? ' is-odd' : ''}`} role="listitem" aria-label={`${d.k}: ${d.v}`}>
            <span className="vbar__v mono">{d.v}</span>
            <span className="vbar__fill" style={{ height: `${(d.v / max) * 100}%` }} />
            <span className="vbar__k mono">{d.k}</span>
          </div>
        ))}
      </div>
      {oddKey && <p className="faint small">{oddKey}</p>}
    </figure>
  );
}

function ChecksList({ checks }: { checks: Array<{ id: string; label: string; passed: boolean; detail: string }> }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.id} className={c.passed ? 'is-pass' : 'is-fail'}>
          <Icon name={c.passed ? 'check' : 'cross'} size={14} />
          <div>
            <strong>{c.label}</strong>
            <p className="small muted">{c.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function VertexChips({ ids, kind, onPick }: { ids: Array<{ id: string; note?: string }>; kind: string; onPick: (id: string) => void }) {
  const selection = useWorkspace((s) => s.selection);
  return (
    <div className="vchips" role="list">
      {ids.slice(0, 160).map((v) => (
        <button key={v.id} type="button" role="listitem" className={`vchip vchip--${kind}`} aria-pressed={selection?.type === 'vertex' && selection.id === v.id} onClick={() => onPick(v.id)} data-testid={`vchip-${v.id}`}>
          {v.id}
          {v.note ? <span className="mono faint"> {v.note}</span> : null}
        </button>
      ))}
      {ids.length > 160 && <span className="faint small">+{ids.length - 160} more</span>}
    </div>
  );
}

function UndirectedPanel({ r, step }: { r: OptimizationRecord; step: StepId }) {
  const ws = useWorkspace.getState();
  const focusPair = useWorkspace((s) => s.focusPair);
  const inspect = useWorkspace((s) => s.inspectPath);
  const pick = (id: string) => {
    ws.select({ type: 'vertex', id });
    ws.cameraCommand('focus-node');
  };
  const degreeHist = useMemo(() => {
    const m = new Map<number, number>();
    for (const d of r.degrees) m.set(d.requiredDegree, (m.get(d.requiredDegree) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => ({ k: String(k), v, odd: k % 2 === 1 }));
  }, [r]);
  const sumDeg = r.degrees.reduce((s, d) => s + d.requiredDegree, 0);
  const greedy = r.baselines.find((b) => b.id === 'greedy-pairing');
  const k = r.oddVertexIds.length;
  switch (step) {
    case 'network':
      return (
        <dl className="stat-grid stat-grid--4">
          <div><dt>Intersections</dt><dd className="num">{formatNumber(r.input.vertexCount)}</dd></div>
          <div><dt>Streets</dt><dd className="num">{formatNumber(r.input.edgeCount)}</dd></div>
          <div><dt>Required</dt><dd className="num">{formatNumber(r.input.requiredEdgeCount)}</dd></div>
          <div><dt>Required length</dt><dd className="num">{formatDistance(r.route.requiredDistance)}</dd></div>
        </dl>
      );
    case 'degrees':
      return (
        <div className="math-split">
          <Bars data={degreeHist} label="Intersections by required degree" oddKey="Odd degrees are highlighted; only they force repetition." />
          <div className="math-note">
            <p className="eyebrow">Handshake lemma</p>
            <p className="mono">Σ deg(v) = {formatNumber(sumDeg)} = 2 × {formatNumber(sumDeg / 2)} required streets</p>
            <p className="small muted">Every street adds 1 to the degree of each end (a loop adds 2), so the sum is even and the number of odd intersections is even too.</p>
          </div>
        </div>
      );
    case 'odd':
      return k === 0 ? (
        <p className="diag diag--ok"><Icon name="check" size={14} /> No odd intersections: an Euler circuit exists without repeating any street.</p>
      ) : (
        <>
          <p className="small muted">{k} odd intersections (k is even, as the handshake lemma requires). Select one to see its matched partner and shortest path in the city.</p>
          <VertexChips ids={r.oddVertexIds.map((id) => ({ id }))} kind="odd" onPick={pick} />
        </>
      );
    case 'paths': {
      const M = r.oddDistanceMatrix;
      const matched = new Set(r.matching.pairs.map((p) => `${p.a}|${p.b}`));
      if (k === 0) return <p className="muted">No odd intersections, so no shortest paths are needed.</p>;
      if (!M) return <p className="muted small">The full distance matrix is kept only for up to 24 odd intersections (here {k}). The matched pairs below are still exact.</p>;
      const max = Math.max(1, ...M.flat());
      return (
        <div className="matrix-wrap">
          <table className="matrix" aria-label="Shortest-path distances between odd intersections">
            <thead>
              <tr>
                <th />
                {r.oddVertexIds.map((id) => (
                  <th key={id} scope="col" className="mono">{id}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.oddVertexIds.map((a, i) => (
                <tr key={a}>
                  <th scope="row" className="mono">{a}</th>
                  {r.oddVertexIds.map((b, j) => {
                    const d = M[i]![j]!;
                    const isMatch = matched.has(`${a}|${b}`) || matched.has(`${b}|${a}`);
                    const sel = inspect && ((inspect.from === a && inspect.to === b) || (inspect.from === b && inspect.to === a));
                    return (
                      <td key={b} className={`${isMatch ? 'is-match' : ''}${sel ? ' is-sel' : ''}`} style={{ ['--h' as string]: String(d / max) }}>
                        {i === j ? '·' : (
                          <button type="button" onClick={() => ws.inspectBetween(a, b)} aria-label={`Shortest path ${a} to ${b}: ${formatNumber(d)}`}>
                            {formatNumber(d)}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="faint small">Outlined cells are the pairs chosen by the minimum matching. Select any cell to draw that shortest path in the city.{inspect ? ` Showing ${inspect.from} → ${inspect.to}: ${formatDistance(inspect.distance)} via ${inspect.edgeIds.length} streets.` : ''}</p>
        </div>
      );
    }
    case 'matching':
      return (
        <div className="math-split">
          <table className="table table--compact">
            <caption className="small muted">Minimum-weight perfect matching ({r.matching.pairs.length} pairs)</caption>
            <thead><tr><th>Pair</th><th>Distance</th><th>Streets</th></tr></thead>
            <tbody>
              {r.matching.pairs.slice(0, 80).map((p, i) => (
                <tr key={`${p.a}-${p.b}`} className={focusPair === i ? 'is-sel' : ''}>
                  <td><button type="button" className="link-btn mono" onClick={() => ws.setFocusPair(focusPair === i ? null : i)} data-testid={`pair-${i}`}>{p.a} ↔ {p.b}</button></td>
                  <td className="mono">{formatDistance(p.distance)}</td>
                  <td className="mono">{p.pathEdgeIds.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="readout-list readout-list--compact">
            <div><dt>Matching cost</dt><dd className="num">{formatDistance(r.matching.cost)}</dd></div>
            {greedy?.total != null && <div><dt>Greedy pairing would add</dt><dd className="num">{formatDistance(greedy.total - r.route.requiredDistance)}</dd></div>}
            <div><dt>LP dual certificate</dt><dd className={`status-pill${r.matching.dualCertificateVerified ? ' is-ok' : ' is-bad'}`}>{r.matching.dualCertificateVerified ? 'verified' : 'failed'}</dd></div>
            {r.matching.crossCheckCost !== null && <div><dt>Subset-DP cross-check</dt><dd className="num">{formatDistance(r.matching.crossCheckCost)}</dd></div>}
            {r.matching.optimalPairingCount !== null && <div><dt>Optimal pairings</dt><dd className="num">{formatNumber(r.matching.optimalPairingCount)}</dd></div>}
          </dl>
        </div>
      );
    case 'augment':
      return <AddedTable rows={Object.entries(r.augmentation.addedCopies)} total={r.augmentation.addedDistance} before={`${k} odd`} after={r.augmentation.allDegreesEven ? '0 odd' : 'odd remain'} />;
    case 'euler':
      return <EulerSequence r={r} />;
    case 'verify':
      return <ChecksList checks={r.checks} />;
    default:
      return null;
  }
}

function AddedTable({ rows, total, before, after }: { rows: Array<[string, number]>; total: number; before: string; after: string }) {
  const graph = useRoute().graph;
  const w = new Map(graph.edges.map((e) => [e.id, e]));
  return (
    <div className="math-split">
      <table className="table table--compact">
        <caption className="small muted">Added copies ({rows.length} streets)</caption>
        <thead><tr><th>Street</th><th>Copies</th><th>Length</th></tr></thead>
        <tbody>
          {rows.slice(0, 80).map(([id, c]) => (
            <tr key={id}>
              <td><button type="button" className="link-btn mono" onClick={() => useWorkspace.getState().select({ type: 'edge', id })}>{w.get(id)?.name ?? id}</button></td>
              <td className="mono">×{c}</td>
              <td className="mono">{formatDistance((w.get(id)?.weight ?? 0) * c)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="readout-list readout-list--compact">
        <div><dt>Added distance</dt><dd className="num num--repeat">{formatDistance(total)}</dd></div>
        <div><dt>Before</dt><dd className="mono">{before}</dd></div>
        <div><dt>After</dt><dd className="mono">{after}</dd></div>
      </dl>
    </div>
  );
}

function EulerSequence({ r }: { r: OptimizationRecord | DirectedOptimizationRecord }) {
  const steps = r.route.steps;
  const closed = steps.length > 0 && steps[0]!.from === steps[steps.length - 1]!.to;
  return (
    <div>
      <div className="btn-row">
        <button type="button" className="btn btn--quiet btn--sm" onClick={() => { routeClock.seek(0); routeClock.play(); useWorkspace.getState().setPlaying(true); }} data-testid="math-play">
          <Icon name="play" size={13} /> Play the circuit
        </button>
        <span className={`status-pill${closed ? ' is-ok' : ' is-bad'}`}>{closed ? `Closed at ${r.input.depotId}` : 'Not closed'}</span>
      </div>
      <ol className="euler-seq" aria-label="Euler circuit, first traversals">
        {steps.slice(0, 240).map((s) => (
          <li key={s.index} className={`kind--${s.kind}`}>
            <button type="button" onClick={() => routeClock.seek(s.cumulative - s.weight + 0.0001)} title={`${s.from} → ${s.to} · ${formatDistance(s.weight)}`}>
              <span className="mono faint">{s.index + 1}</span> {s.from}→{s.to}
            </button>
          </li>
        ))}
        {steps.length > 240 && <li className="faint small">… {steps.length - 240} more</li>}
      </ol>
    </div>
  );
}

function DirectedPanel({ r, step }: { r: DirectedOptimizationRecord; step: StepId }) {
  const ws = useWorkspace.getState();
  const focusPair = useWorkspace((s) => s.focusPair);
  const pick = (id: string) => {
    ws.select({ type: 'vertex', id });
    ws.cameraCommand('focus-node');
  };
  const imbalanced = r.balance.filter((b) => b.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const greedy = r.baselines.find((b) => b.id === 'greedy-balancing');
  switch (step) {
    case 'network':
      return (
        <dl className="stat-grid stat-grid--4">
          <div><dt>Streets</dt><dd className="num">{formatNumber(r.input.edgeCount)}</dd></div>
          <div><dt>One-way</dt><dd className="num">{formatNumber(r.input.onewayEdgeCount)}</dd></div>
          <div><dt>Permitted directions</dt><dd className="num">{formatNumber(r.input.arcCount)}</dd></div>
          <div><dt>Directions to service</dt><dd className="num">{formatNumber(r.input.requiredArcCount)}</dd></div>
        </dl>
      );
    case 'balance': {
      const rows = [...r.balance].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 40);
      const max = Math.max(1, ...rows.map((b) => Math.max(b.inRequired, b.outRequired)));
      return (
        <div className="math-split">
          <div className="balance-bars" role="list" aria-label="Required arrivals and departures per intersection">
            {rows.map((b) => (
              <button key={b.vertexId} type="button" role="listitem" className="balance-row" onClick={() => pick(b.vertexId)}>
                <span className="mono">{b.vertexId}</span>
                <span className="balance-row__in" style={{ width: `${(b.inRequired / max) * 50}%` }} />
                <span className="balance-row__out" style={{ width: `${(b.outRequired / max) * 50}%` }} />
                <span className={`mono ${b.delta !== 0 ? 'is-imb' : 'faint'}`}>{b.delta > 0 ? `+${b.delta}` : b.delta}</span>
              </button>
            ))}
          </div>
          <div className="math-note">
            <p className="eyebrow">Balance condition</p>
            <p className="mono">δ(v) = in(v) − out(v), Σ δ = {r.balance.reduce((s, b) => s + b.delta, 0)}</p>
            <p className="small muted">A closed route that obeys one-way rules leaves each intersection exactly as often as it arrives. Arrivals are drawn left, departures right; δ ≠ 0 means extra driving is unavoidable there.</p>
          </div>
        </div>
      );
    }
    case 'imbalanced':
      return imbalanced.length === 0 ? (
        <p className="diag diag--ok"><Icon name="check" size={14} /> Every intersection is balanced; the required arcs already form a directed Euler circuit.</p>
      ) : (
        <>
          <p className="small muted">Surplus (δ &gt; 0): must be left extra times. Deficit (δ &lt; 0): must be entered extra times.</p>
          <VertexChips ids={imbalanced.filter((b) => b.delta > 0).map((b) => ({ id: b.vertexId, note: `+${b.delta}` }))} kind="surplus" onPick={pick} />
          <VertexChips ids={imbalanced.filter((b) => b.delta < 0).map((b) => ({ id: b.vertexId, note: String(b.delta) }))} kind="deficit" onPick={pick} />
        </>
      );
    case 'paths':
    case 'flow':
      return (
        <div className="math-split">
          <table className="table table--compact">
            <caption className="small muted">{step === 'flow' ? 'Flow decomposed into shortest legal paths' : 'Shortest legal paths used by the flow'}</caption>
            <thead><tr><th>From → to</th><th>Units</th><th>Length</th></tr></thead>
            <tbody>
              {r.flow.paths.slice(0, 80).map((p, i) => (
                <tr key={i} className={focusPair === i ? 'is-sel' : ''}>
                  <td><button type="button" className="link-btn mono" onClick={() => ws.setFocusPair(focusPair === i ? null : i)} data-testid={`flow-${i}`}>{p.from} → {p.to}</button></td>
                  <td className="mono">{p.units}</td>
                  <td className="mono">{formatDistance(p.distance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="readout-list readout-list--compact">
            <div><dt>Flow cost</dt><dd className="num">{formatDistance(r.flow.cost)}</dd></div>
            <div><dt>Units</dt><dd className="num">{r.flow.totalUnits}</dd></div>
            {greedy?.total != null && <div><dt>Greedy balancing would add</dt><dd className="num">{formatDistance(greedy.total - r.route.requiredDistance)}</dd></div>}
            <div><dt>LP dual certificate</dt><dd className={`status-pill${r.flow.dualCertificateVerified ? ' is-ok' : ' is-bad'}`}>{r.flow.dualCertificateVerified ? 'verified' : 'failed'}</dd></div>
            {r.flow.crossCheckCost !== null && <div><dt>State-space cross-check</dt><dd className="num">{formatDistance(r.flow.crossCheckCost)}</dd></div>}
            {r.algorithm.orientationSearch && <div><dt>Service directions tried</dt><dd className="num">{formatNumber(r.algorithm.orientationSearch.orientationsEvaluated)}</dd></div>}
          </dl>
        </div>
      );
    case 'augment':
      return <AddedTable rows={Object.entries(r.augmentation.addedEdgeCopies)} total={r.augmentation.addedDistance} before={`${imbalanced.length} imbalanced`} after={r.augmentation.balanced ? '0 imbalanced' : 'imbalanced remain'} />;
    case 'euler':
      return <EulerSequence r={r} />;
    case 'verify':
      return <ChecksList checks={r.checks} />;
    default:
      return null;
  }
}

/** The whole computation at a glance: one key figure per step, read from the record. */
function MathOverview() {
  const result = useWorkspace((s) => s.result)!;
  const setStep = useWorkspace((s) => s.setAnalysisStep);
  const { steps } = useRoute();
  const figure = (id: StepId): string => {
    if (result.mode === 'directed') {
      const d = result as DirectedOptimizationRecord;
      switch (id) {
        case 'network': return `${formatNumber(d.input.arcCount)} directions`;
        case 'balance': return `${formatNumber(d.balance.length)} intersections`;
        case 'imbalanced': return `${formatNumber(d.imbalancedVertexIds.length)} imbalanced`;
        case 'paths': return `${formatNumber(d.flow.paths.length)} paths`;
        case 'flow': return formatDistance(d.flow.cost);
        case 'augment': return `+${formatDistance(d.augmentation.addedDistance)}`;
        case 'euler': return `${formatNumber(d.route.steps.length)} steps`;
        default: return `${d.checks.filter((c) => c.passed).length}/${d.checks.length} checks`;
      }
    }
    const u = result as OptimizationRecord;
    const k = u.oddVertexIds.length;
    switch (id) {
      case 'network': return `${formatNumber(u.input.edgeCount)} streets`;
      case 'degrees': return `Σ deg ${formatNumber(u.degrees.reduce((s, x) => s + x.requiredDegree, 0))}`;
      case 'odd': return `${formatNumber(k)} odd`;
      case 'paths': return `${formatNumber((k * (k - 1)) / 2)} pairs`;
      case 'matching': return formatDistance(u.matching.cost);
      case 'augment': return `+${formatDistance(u.augmentation.addedDistance)}`;
      case 'euler': return `${formatNumber(u.route.steps.length)} steps`;
      default: return `${u.checks.filter((c) => c.passed).length}/${u.checks.length} checks`;
    }
  };
  return (
    <>
      <p className="muted small">The computation for this run, step by step. Choose a step to see its working here and its intersections and streets highlighted in the city and on the map.</p>
      <ol className="math-overview" data-testid="math-overview">
        {steps.map((s) => (
          <li key={s.id}>
            <button type="button" onClick={() => setStep(s.id)}>
              <span className="math-overview__k">{s.kicker}</span>
              <span>{s.title}</span>
              <span className="math-overview__v">{figure(s.id)}</span>
            </button>
          </li>
        ))}
      </ol>
    </>
  );
}

export function MathSection() {
  const { steps, graph, theme, tracks2d, colors, highlight, fresh } = useRoute();
  const reduced = useReducedMotion();
  const result = useWorkspace((s) => s.result);
  const step = useWorkspace((s) => s.analysisStep);
  const setStep = useWorkspace((s) => s.setAnalysisStep);
  const current = steps.find((s) => s.id === step) ?? null;
  const idx = current ? steps.indexOf(current) : -1;
  return (
    <section id="surface-mathematics" className="surface surface--math" aria-labelledby="math-h">
      <header className="surface__head">
        <p className="eyebrow">D · Mathematical investigation</p>
        <h2 id="math-h" className="dim-title">
          {result?.mode === 'directed' ? 'Why this route is the shortest legal one.' : 'Why this route is the shortest one.'}
        </h2>
        <p className="surface__lede muted">
          {result?.mode === 'directed'
            ? 'Directed Chinese Postman: balance in- and out-degrees with a minimum-cost flow over permitted directions, then walk a directed Euler circuit. Every value below is read from this run.'
            : 'Undirected Chinese Postman (Edmonds–Johnson): pair odd intersections by a minimum-weight perfect matching, repeat the matched shortest paths, then walk an Euler circuit. Every value below is read from this run.'}
        </p>
      </header>
      {!result || !fresh ? (
        <p className="muted">Optimise the network to investigate its computation.</p>
      ) : (
        <div className="math-grid">
          <nav className="math-rail" aria-label="Algorithm steps">
            <ol>
              {steps.map((s) => (
                <li key={s.id}>
                  <button type="button" className={`math-rail__step${s.id === step ? ' is-active' : ''}`} aria-current={s.id === step ? 'step' : undefined} onClick={() => setStep(s.id === step ? null : s.id)} data-testid={`math-step-${s.id}`}>
                    <span className="math-rail__k mono">{s.kicker}</span>
                    <span>{s.title}</span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="btn-row">
              <button type="button" className="btn btn--ghost btn--sm" disabled={idx <= 0} onClick={() => setStep(steps[idx - 1]!.id)} aria-label="Previous step" data-testid="math-prev">
                <Icon name="prev" size={14} />
              </button>
              <button type="button" className="btn btn--ghost btn--sm" disabled={idx >= steps.length - 1} onClick={() => setStep(steps[Math.max(0, idx + 1)]!.id)} aria-label="Next step" data-testid="math-next">
                <Icon name="next" size={14} />
              </button>
              {step && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setStep(null)}>
                  Clear highlight
                </button>
              )}
            </div>
          </nav>
          <article className="math-panel" aria-live="polite" data-testid="math-panel">
            {current ? (
              <>
                <p className="eyebrow">Step {current.kicker}</p>
                <h3 className="math-panel__title">{current.title}</h3>
                <p className="math-panel__summary">{current.summary}</p>
                {result.mode === 'directed' ? <DirectedPanel r={result as DirectedOptimizationRecord} step={current.id} /> : <UndirectedPanel r={result as OptimizationRecord} step={current.id} />}
              </>
            ) : (
              <MathOverview />
            )}
          </article>
          <div className="math-map">
            <RouteProjection
              graph={graph}
              tracks={highlight.showRoute ? tracks2d : []}
              trackColors={colors}
              theme={theme}
              reduced={reduced}
              highlight={step ? highlight : { ...highlight, showRoute: true }}
              depotId={result.input.depotId}
              showOrder={false}
              label="Highlights for the selected algorithm step."
              testId="math-map"
            />
          </div>
        </div>
      )}
    </section>
  );
}
