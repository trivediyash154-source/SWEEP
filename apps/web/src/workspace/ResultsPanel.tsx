import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Graph } from '@sweep/engine';
import { api } from '../lib/api';
import { edgesToCsv, routeToCsv, type OptimizationRecord } from '@sweep/engine';
import { useWorkspace } from '../state/workspace';
import { formatDistance, formatMs, formatNumber, formatPercent, plural } from '../lib/format';
import { downloadText, safeFileName, writeJson } from '../lib/storage';
import { Icon } from '../components/Icon';

export const REPORT_KEY = 'sweep.lastReport.v1';

function BaselineBars({ record }: { record: OptimizationRecord }) {
  const rows = [
    { id: 'optimal', label: 'SWEEP optimal route', total: record.route.totalDistance, tone: 'route', note: record.algorithm.optimal ? 'certified optimal' : 'not certified' },
    ...record.baselines.map((b) => ({ id: b.id, label: b.label, total: b.total ?? 0, tone: b.id === 'lower-bound' ? 'bound' : 'baseline', note: b.isValidRoute ? 'valid route' : 'bound only' })),
  ];
  const max = Math.max(...rows.map((r) => r.total), 1);
  return (
    <div className="bars" role="table" aria-label="Route length compared with baselines">
      {rows.map((r) => (
        <div className="bars__row" role="row" key={r.id}>
          <span className="bars__label" role="cell">
            {r.label}
            <span className="faint small"> · {r.note}</span>
          </span>
          <span className="bars__track" role="cell" aria-hidden="true">
            <span className={`bars__fill bars__fill--${r.tone}`} style={{ width: `${(r.total / max) * 100}%` }} />
          </span>
          <span className="bars__value num" role="cell">
            {formatDistance(r.total)}
          </span>
        </div>
      ))}
    </div>
  );
}

interface RunSummary {
  id: string;
  createdAt: number;
  summary: { totalDistance: number; optimal: boolean; checksPassed: boolean };
}

/** Stored runs for an account scenario: reopen any previous optimisation. */
function RunHistory() {
  const ref = useWorkspace((s) => s.ref);
  const runsNonce = useWorkspace((s) => s.runsNonce);
  const runId = useWorkspace((s) => s.runId);
  const showRun = useWorkspace((s) => s.showRun);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  useEffect(() => {
    if (ref?.kind !== 'remote') return;
    api<RunSummary[]>(`/scenarios/${ref.id}/runs`)
      .then(setRuns)
      .catch(() => setRuns(null));
  }, [ref, runsNonce]);
  if (ref?.kind !== 'remote' || !runs || runs.length === 0) return null;
  return (
    <>
      <h3 className="panel-subtitle">Stored runs</h3>
      <ul className="runs" data-testid="run-history">
        {runs.slice(0, 8).map((r) => (
          <li key={r.id} className={r.id === runId ? 'is-current' : ''}>
            <button
              type="button"
              className="link-btn"
              onClick={() => void api<{ id: string; graph: Graph; record: OptimizationRecord }>(`/runs/${r.id}`).then(showRun)}
            >
              {new Date(r.createdAt).toLocaleString()}
            </button>
            <span className="num small">{formatDistance(r.summary.totalDistance)}</span>
            <Link to={`/report/${r.id}`} className="small">
              report
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export function ResultsPanel() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { result, resultGraph, failure, stale, optimizing, error, resultSource } = ws;

  if (optimizing && !result) {
    return (
      <div className="empty-state" role="status">
        <span className="spinner" aria-hidden="true" />
        <h3>Solving…</h3>
        <p>Computing shortest paths and an exact minimum matching.</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="empty-state" role="alert">
        <h3>Optimisation could not run</h3>
        <p>{error}</p>
        <button type="button" className="btn btn--quiet" onClick={() => void ws.runOptimize()}>
          Try again
        </button>
      </div>
    );
  }
  if (failure) {
    return (
      <div className="results results--failure" role="alert" data-testid="results-failure">
        <p className="eyebrow">No route produced</p>
        <h3 className="results__headline">This network cannot be optimised yet.</h3>
        <ul className="diag-list">
          {failure.issues
            .filter((i) => i.severity === 'error')
            .map((i, idx) => (
              <li key={idx} className="diag diag--error">
                <span className="diag__badge">{i.code.replace(/_/g, ' ').toLowerCase()}</span>
                <span>{i.message}</span>
              </li>
            ))}
        </ul>
        {failure.connectorSuggestion && failure.connectorSuggestion.edgeIds.length > 0 && (
          <button type="button" className="btn btn--quiet" onClick={() => ws.applyConnectorSuggestion()}>
            Mark suggested connecting streets as required
          </button>
        )}
      </div>
    );
  }
  if (!result || !resultGraph) {
    return (
      <div className="empty-state">
        <Icon name="route" size={28} />
        <h3>No route yet</h3>
        <p>Press <strong>Optimize route</strong> to compute the shortest closed route that services every required street.</p>
      </div>
    );
  }

  const repeatedShare = result.route.totalDistance > 0 ? result.route.repeatedDistance / result.route.totalDistance : 0;
  const greedy = result.baselines.find((b) => b.id === 'greedy-pairing')?.total ?? null;
  const doubled = result.baselines.find((b) => b.id === 'double-every-street')?.total ?? null;
  const base = safeFileName(ws.name);

  const exportJson = (): void =>
    downloadText(
      `${base}-route.json`,
      JSON.stringify({ format: 'sweep.run', version: 1, scenario: ws.name, exportedAt: new Date().toISOString(), graph: resultGraph, result }, null, 2),
      'application/json',
    );

  const openReport = (): void => {
    if (ws.runId) {
      navigate(`/report/${ws.runId}`);
      return;
    }
    writeJson(REPORT_KEY, { name: ws.name, graph: resultGraph, result, source: resultSource, savedAt: Date.now() });
    navigate('/report');
  };

  return (
    <div className="results" data-testid="results">
      {stale && (
        <div className="notice notice--warn" role="status">
          The network changed after this route was computed. Results below describe the previous version.
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => void ws.runOptimize()}>
            Re-optimise
          </button>
        </div>
      )}
      <p className="eyebrow">Optimised closed route</p>
      <div className="results__total">
        <span className="results__big num" data-testid="total-distance">
          {formatDistance(result.route.totalDistance)}
        </span>
        {result.algorithm.optimal ? (
          <span className="chip chip--ok" data-testid="optimal-chip">
            <span className="dot" /> Optimal · certified
          </span>
        ) : (
          <span className="chip chip--danger">
            <span className="dot" /> Not certified
          </span>
        )}
      </div>
      <dl className="stat-grid stat-grid--results">
        <div>
          <dt>Required streets</dt>
          <dd className="num">{formatDistance(result.route.requiredDistance)}</dd>
        </div>
        <div>
          <dt>Repeated distance</dt>
          <dd className="num" style={{ color: 'var(--repeat)' }} data-testid="repeated-distance">
            {formatDistance(result.route.repeatedDistance)}
            <span className="faint small"> · {formatPercent(repeatedShare)}</span>
          </dd>
        </div>
        <div>
          <dt>Odd intersections</dt>
          <dd className="num">{formatNumber(result.oddVertexIds.length)}</dd>
        </div>
        <div>
          <dt>Matched pairs</dt>
          <dd className="num">{formatNumber(result.matching.pairs.length)}</dd>
        </div>
        <div>
          <dt>Route steps</dt>
          <dd className="num">{formatNumber(result.route.steps.length)}</dd>
        </div>
        <div>
          <dt>Repeat / deadhead passes</dt>
          <dd className="num">
            {result.route.repeatedRequiredTraversals} / {result.route.deadheadTraversals}
          </dd>
        </div>
      </dl>

      <h3 className="panel-subtitle">Compared with</h3>
      <BaselineBars record={result} />
      <p className="faint small">
        {greedy !== null && greedy > result.route.totalDistance
          ? `Exact matching saves ${formatDistance(greedy - result.route.totalDistance)} over greedy pairing on this network.`
          : 'On this network greedy pairing happens to find an optimal pairing too; exact matching guarantees it.'}{' '}
        {doubled !== null ? `Out-and-back on every street would cost ${formatDistance(doubled)}.` : ''}
      </p>

      <h3 className="panel-subtitle">Verification</h3>
      <ul className="checks" data-testid="checks">
        {result.checks.map((c) => (
          <li key={c.id} className={c.passed ? 'is-pass' : 'is-fail'}>
            <span className="checks__icon" aria-hidden="true">
              <Icon name={c.passed ? 'check' : 'cross'} size={13} />
            </span>
            <span>
              <strong>{c.label}</strong>
              <span className="faint small block">{c.detail}</span>
            </span>
            <span className="visually-hidden">{c.passed ? 'passed' : 'failed'}</span>
          </li>
        ))}
      </ul>
      {result.matching.optimalPairingCount !== null && result.matching.optimalPairingCount > 1 && (
        <p className="notice notice--info">
          {plural(result.matching.optimalPairingCount, 'pairing')} of odd intersections are equally optimal. SWEEP chose one deterministically; every one gives the same total.
        </p>
      )}

      <h3 className="panel-subtitle">Assumptions</h3>
      <ul className="assumptions small muted">
        <li>Undirected streets: each can be driven either way.</li>
        <li>Closed route from the start marker back to it.</li>
        <li>Lengths are the stated street lengths; turn costs are not modelled.</li>
        <li>{result.input.optionalEdgeCount > 0 ? 'Optional streets may be used to reposition (deadhead) but need no service.' : 'Every street must be serviced.'}</li>
      </ul>

      <div className="engine-meta mono small faint">
        <span>
          engine {result.engine.version} · {resultSource === 'server' ? 'server' : 'in-browser'} · {formatMs(result.timingsMs.total)}
        </span>
        <span title={result.input.graphHash}>input {result.input.graphHash.slice(0, 12)}…</span>
      </div>

      <RunHistory />

      <div className="btn-row btn-row--wrap">
        <button type="button" className="btn btn--quiet btn--sm" onClick={exportJson} data-testid="export-json">
          <Icon name="export" size={14} /> JSON
        </button>
        <button type="button" className="btn btn--quiet btn--sm" onClick={() => downloadText(`${base}-route.csv`, routeToCsv(result, resultGraph), 'text/csv')}>
          <Icon name="export" size={14} /> Route CSV
        </button>
        <button type="button" className="btn btn--quiet btn--sm" onClick={() => downloadText(`${base}-streets.csv`, edgesToCsv(result, resultGraph), 'text/csv')}>
          <Icon name="export" size={14} /> Streets CSV
        </button>
        <button type="button" className="btn btn--quiet btn--sm" onClick={openReport} data-testid="open-report">
          <Icon name="layers" size={14} /> Report
        </button>
      </div>
    </div>
  );
}
