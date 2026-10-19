import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../state/auth';
import { api } from '../lib/api';
import { useWorkspace } from '../state/workspace';
import { formatDistance, formatMs, formatNumber } from '../lib/format';
import { listExperiments, deleteExperiment, clearAllLocalData, type Experiment } from '../lib/experiments';
import { listLocalScenarios, deleteLocalScenario, saveLocalScenario, newId, type LocalScenario } from '../lib/storage';
import { downloadFleetCsv, downloadGeoJson, downloadJson, downloadRouteCsv, downloadStreetsCsv, prepareReport, type ExportInput } from '../lib/exports';
import { toast } from '../state/toasts';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { SOURCE_LABEL } from './SimulationSection';

function Check({ c }: { c: { id: string; label: string; passed: boolean; detail: string } }) {
  return (
    <li className={c.passed ? 'is-pass' : 'is-fail'} data-testid={`check-${c.id}`}>
      <Icon name={c.passed ? 'check' : 'cross'} size={15} />
      <div>
        <strong>{c.label}</strong>
        <p className="small muted">{c.detail}</p>
      </div>
    </li>
  );
}

/* ---------------------------------------------------------------- G */
export function VerificationSection() {
  const result = useWorkspace((s) => s.result);
  const fleet = useWorkspace((s) => s.fleet);
  const stale = useWorkspace((s) => s.stale);
  const source = useWorkspace((s) => s.resultSource);
  const settings = useWorkspace((s) => s.resultSettings);
  const failure = useWorkspace((s) => s.failure);
  const graph = useWorkspace((s) => s.resultGraph);
  return (
    <section id="surface-verification" className="surface" aria-labelledby="ver-h" data-testid="verification">
      <header className="surface__head">
        <p className="eyebrow">G · Verification and technical report</p>
        <h2 id="ver-h" className="dim-title">Checked, independently.</h2>
        <p className="surface__lede muted">The verifier re-derives every invariant from the raw network and the ordered route; it shares no code with the solver.</p>
      </header>
      {failure && !result ? (
        <div className="notice notice--warn" role="alert">
          <strong>The solver refused this network.</strong>
          <ul className="diag-list">
            {failure.issues.filter((i) => i.severity === 'error').map((i, k) => (
              <li key={k} className="diag diag--error">
                <span className="diag__badge">{i.code}</span> <span>{i.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : !result ? (
        <p className="muted">No result yet.</p>
      ) : (
        <div className="ver-grid">
          <article className="ver-card ver-card--status">
            <p className={`ver-verdict${result.algorithm.optimal && !stale ? ' is-ok' : ' is-bad'}`} data-testid="ver-verdict">
              <Icon name={result.algorithm.optimal ? 'shield' : 'cross'} size={22} />
              {stale ? 'Out of date: the network changed after this run.' : result.algorithm.optimal ? 'Optimal and verified' : 'Not certified'}
            </p>
            <p className="small">{result.algorithm.optimalityBasis}</p>
            <dl className="kv kv--tight">
              <dt>Problem</dt>
              <dd className="mono">{result.algorithm.problem}</dd>
              <dt>Engine</dt>
              <dd className="mono">
                {result.engine.name} {result.engine.version} · {source === 'server' ? 'server' : 'in-browser worker'}
              </dd>
              <dt>Input hash</dt>
              <dd className="mono small" title={result.input.graphHash}>{result.input.graphHash.slice(0, 16)}…</dd>
              <dt>Start</dt>
              <dd className="mono">{result.input.depotId}</dd>
              {settings && (
                <>
                  <dt>Settings</dt>
                  <dd className="mono small">
                    {settings.mode}
                    {settings.mode === 'directed' ? ` · two-way ${settings.twoWay}` : settings.ignoreOneway ? ' · one-way ignored' : ''} · {settings.vehicles} vehicle{settings.vehicles === 1 ? '' : 's'}
                    {settings.vehicles > 1 ? ` · ${settings.objective}` : ''}
                  </dd>
                </>
              )}
              <dt>Timings</dt>
              <dd className="mono small">
                {Object.entries(result.timingsMs)
                  .map(([k, v]) => `${k} ${formatMs(v)}`)
                  .join(' · ')}
              </dd>
              {graph?.source?.attribution && (
                <>
                  <dt>Data</dt>
                  <dd className="small">
                    {SOURCE_LABEL[graph.source.kind]} · {graph.source.attribution} ({graph.source.license})
                  </dd>
                </>
              )}
            </dl>
          </article>
          <article className="ver-card">
            <h3 className="panel-title">Route checks ({result.checks.filter((c) => c.passed).length}/{result.checks.length})</h3>
            <ul className="checks">
              {result.checks.map((c) => (
                <Check key={c.id} c={c} />
              ))}
            </ul>
          </article>
          {fleet && (
            <article className="ver-card">
              <h3 className="panel-title">Fleet checks</h3>
              <ul className="checks">
                {fleet.checks.map((c) => (
                  <Check key={`f-${c.id}`} c={c} />
                ))}
              </ul>
              <p className="small">{fleet.algorithm.guarantee}</p>
              <table className="table table--compact">
                <thead>
                  <tr>
                    <th>Vehicle</th>
                    <th>Length</th>
                    <th>Approach</th>
                    <th>Return</th>
                    <th>Serviced</th>
                    <th>Valid</th>
                  </tr>
                </thead>
                <tbody>
                  {fleet.routes.map((r) => (
                    <tr key={r.vehicle}>
                      <td className="mono">V{r.vehicle}</td>
                      <td className="mono">{formatDistance(r.distance)}</td>
                      <td className="mono">{formatDistance(r.approachDistance)}</td>
                      <td className="mono">{formatDistance(r.returnDistance)}</td>
                      <td className="mono">{formatNumber(r.servicedEdgeIds.length)}</td>
                      <td>{r.checks.every((c) => c.passed) ? <span className="status-pill is-ok">yes</span> : <span className="status-pill is-bad">no</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <dl className="readout-list readout-list--compact">
                <div><dt>Longest route</dt><dd className="num">{formatDistance(fleet.makespan)}</dd></div>
                <div><dt>Lower bound</dt><dd className="num">{formatDistance(fleet.lowerBound.value)}</dd></div>
                <div><dt>Gap to bound</dt><dd className="num">{fleet.gapRatio.toFixed(3)}×</dd></div>
                <div><dt>Total vs single route</dt><dd className="num">{formatDistance(fleet.totalDistance)} vs {formatDistance(fleet.singleVehicleDistance)}</dd></div>
              </dl>
            </article>
          )}
          <article className="ver-card">
            <h3 className="panel-title">Assumptions and limits</h3>
            <ul className="bullets small">
              {result.mode === 'directed' ? (
                <>
                  <li>One-way streets are driven only in their permitted direction; two-way streets {settings?.twoWay === 'either' ? 'once in either direction (exact enumeration of directions)' : 'once in each direction'}.</li>
                  <li>The required streets must be connected; disconnected required groups (the directed rural postman problem) are refused rather than approximated.</li>
                </>
              ) : (
                <>
                  <li>Streets may be driven in either direction at the same cost{result.algorithm.directionPolicy === 'oneway-ignored' ? '; one-way restrictions were ignored by request (relaxation).' : '.'}</li>
                  <li>Required streets must be connected; otherwise the problem is the NP-hard rural postman problem and is refused with a connector suggestion.</li>
                </>
              )}
              <li>Costs are the edge weights (lengths); turns, traffic and time windows are not modelled.</li>
              {fleet && <li>Fleet routes share one depot and return to it; distinct depots per vehicle are not supported.</li>}
            </ul>
            {result.warnings.length > 0 && (
              <ul className="diag-list">
                {result.warnings.map((w, i) => (
                  <li key={i} className={`diag diag--${w.severity}`}>
                    <span className="diag__badge">{w.severity}</span> <span>{w.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- H */
export function HistorySection() {
  const navigate = useNavigate();
  const result = useWorkspace((s) => s.result);
  const name = useWorkspace((s) => s.name);
  const ref = useWorkspace((s) => s.ref);
  const dirty = useWorkspace((s) => s.dirty);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [scenarios, setScenarios] = useState<LocalScenario[]>([]);
  const [confirm, setConfirm] = useState(false);
  const auth = useAuth();
  const runId = useWorkspace((s) => s.runId);
  const [accountRuns, setAccountRuns] = useState<Array<{ id: string; createdAt: number; summary: { totalDistance: number; checksPassed: boolean; vehicles?: number; mode?: string } }> | null>(null);
  const refresh = () => {
    setExperiments(listExperiments());
    setScenarios(listLocalScenarios());
  };
  useEffect(refresh, [result, ref, dirty]);
  useEffect(() => {
    if (ref?.kind !== 'remote' || auth.status !== 'signed-in') {
      setAccountRuns(null);
      return;
    }
    api<NonNullable<typeof accountRuns>>(`/scenarios/${ref.id}/runs`)
      .then(setAccountRuns)
      .catch(() => setAccountRuns(null));
  }, [ref, auth.status, runId]);
  const saveAccount = async () => {
    const st = useWorkspace.getState();
    const graph = { ...st.graph, name: st.name };
    try {
      if (st.ref?.kind === 'remote') {
        await api(`/scenarios/${st.ref.id}`, { method: 'PUT', body: { name: st.name, graph } });
        st.markSaved(st.ref);
      } else {
        const created = await api<{ id: string }>('/scenarios', { method: 'POST', body: { name: st.name, graph } });
        st.markSaved({ kind: 'remote', id: created.id });
        navigate(`/lab/${created.id}`, { replace: true });
      }
      toast.success('Saved to your account', st.name);
    } catch (e) {
      toast.error('Could not save to your account', (e as Error).message);
    }
  };
  const saveLocal = () => {
    const st = useWorkspace.getState();
    const id = st.ref?.kind === 'local' ? st.ref.id : newId('local');
    if (!saveLocalScenario({ id, name: st.name, graph: { ...st.graph, name: st.name }, updatedAt: Date.now() })) {
      toast.error('Could not save', 'Browser storage is unavailable or full.');
      return;
    }
    st.markSaved({ kind: 'local', id });
    navigate(`/lab/${id}`, { replace: true });
    toast.success('Saved on this device', st.name);
    refresh();
  };
  return (
    <section id="surface-history" className="surface" aria-labelledby="hist-h">
      <header className="surface__head">
        <p className="eyebrow">H · Scenario and experiment history</p>
        <h2 id="hist-h" className="dim-title">Everything stays on this device.</h2>
        <p className="surface__lede muted">Scenarios and every optimisation run are kept in this browser's local storage. No account is needed; nothing is uploaded.</p>
      </header>
      <div className="hist-grid">
        <article className="hist-card">
          <div className="panel-title-row">
            <h3 className="panel-title">Saved scenarios</h3>
            <div className="btn-row">
              <button type="button" className="btn btn--quiet btn--sm" onClick={saveLocal} data-testid="save-local">
                <Icon name="save" size={14} /> Save “{name}” on this device
              </button>
              {auth.status === 'signed-in' && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void saveAccount()} data-testid="save-account">
                  <Icon name="user" size={14} /> Save to account
                </button>
              )}
            </div>
          </div>
          {accountRuns && (
            <div data-testid="account-runs">
              <h4 className="panel-subtitle">Runs stored in your account for this scenario</h4>
              <ul className="hist-list">
                {accountRuns.map((r) => (
                  <li key={r.id} className={r.id === runId ? 'is-active' : ''}>
                    <span className="hist-item">
                      <strong className="mono">{formatDistance(r.summary.totalDistance)}</strong>
                      <span className="faint small">
                        {new Date(r.createdAt).toLocaleString()} · {r.summary.mode ?? 'undirected'}
                        {r.summary.vehicles && r.summary.vehicles > 1 ? ` · ${r.summary.vehicles} vehicles` : ''} · {r.summary.checksPassed ? 'verified' : 'check failed'}
                      </span>
                    </span>
                    <Link className="btn btn--ghost btn--sm" to={`/report/${r.id}`}>
                      Report
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {scenarios.length === 0 ? (
            <p className="faint small">Nothing saved yet.</p>
          ) : (
            <ul className="hist-list" data-testid="saved-scenarios">
              {scenarios.map((s) => {
                const r = s.graph.routing;
                return (
                  <li key={s.id} className={ref?.id === s.id ? 'is-active' : ''}>
                    <button
                      type="button"
                      className="hist-item"
                      onClick={() => {
                        useWorkspace.getState().loadGraph(s.graph, { kind: 'local', id: s.id }, s.name);
                        navigate(`/lab/${s.id}`, { replace: true });
                      }}
                      data-testid={`open-scenario-${s.id}`}
                    >
                      <strong>{s.name}</strong>
                      <span className="faint small mono">
                        {s.graph.vertices.length} int. · {s.graph.edges.length} streets · {r?.mode ?? 'undirected'}
                        {r?.vehicles && r.vehicles > 1 ? ` · ${r.vehicles} vehicles` : ''} · {new Date(s.updatedAt).toLocaleString()}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--icon btn--sm"
                      aria-label={`Delete ${s.name}`}
                      onClick={() => {
                        deleteLocalScenario(s.id);
                        refresh();
                      }}
                    >
                      <Icon name="delete" size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </article>
        <article className="hist-card hist-card--wide">
          <h3 className="panel-title">Experiment log ({experiments.length})</h3>
          {experiments.length === 0 ? (
            <p className="faint small">Runs appear here as you optimise.</p>
          ) : (
            <div className="table-wrap">
              <table className="table table--compact" data-testid="experiment-log">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Scenario</th>
                    <th>Graph</th>
                    <th>Configuration</th>
                    <th>Result</th>
                    <th>Verified</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {experiments.slice(0, 25).map((e) => (
                    <tr key={e.id}>
                      <td className="mono small">{new Date(e.at).toLocaleTimeString()}</td>
                      <td>{e.name}</td>
                      <td className="mono small">
                        {e.summary.vertexCount}/{e.summary.edgeCount}
                      </td>
                      <td className="mono small">
                        {e.settings.mode}
                        {e.settings.mode === 'directed' ? `·${e.settings.twoWay}` : ''}
                        {e.settings.vehicles > 1 ? ` · ${e.settings.vehicles}×${e.settings.objective}` : ''}
                      </td>
                      <td className="mono small">
                        {formatDistance(e.summary.total)}
                        {e.summary.makespan !== null ? ` · max ${formatDistance(e.summary.makespan)}` : ''}
                      </td>
                      <td>{e.summary.optimal ? <span className="status-pill is-ok">{e.summary.checksPassed}/{e.summary.checksTotal}</span> : <span className="status-pill is-bad">{e.summary.checksPassed}/{e.summary.checksTotal}</span>}</td>
                      <td className="nowrap">
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={!e.graph}
                          title={e.graph ? 'Reopen this configuration' : 'The network was too large to keep a copy'}
                          onClick={() => e.graph && useWorkspace.getState().loadGraph({ ...e.graph, routing: e.settings }, { kind: 'local', id: `exp-${e.id}` }, e.name)}
                        >
                          Reopen
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--icon btn--sm"
                          aria-label="Delete this run"
                          onClick={() => {
                            deleteExperiment(e.id);
                            refresh();
                          }}
                        >
                          <Icon name="delete" size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button type="button" className="btn btn--danger btn--sm" onClick={() => setConfirm(true)} data-testid="clear-data">
            <Icon name="delete" size={14} /> Clear local data…
          </button>
        </article>
      </div>
      {confirm && (
        <Dialog title="Clear all local SWEEP data?" onClose={() => setConfirm(false)}>
          <p>This removes every scenario saved on this device, the experiment log, the current draft and your preferences from this browser. It cannot be undone. Accounts on the server are not affected.</p>
          <div className="dialog__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setConfirm(false)}>
              Keep my data
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                const n = clearAllLocalData();
                setConfirm(false);
                refresh();
                toast.success('Local data cleared', `${n} stored item${n === 1 ? '' : 's'} removed.`);
                useWorkspace.getState().loadExample('meridian-district');
                navigate('/lab', { replace: true });
              }}
              data-testid="confirm-clear"
            >
              Clear everything
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- I */
export function useExportInput(): ExportInput {
  const s = useWorkspace();
  const usable = s.result && !s.stale;
  return {
    name: s.name,
    graph: usable && s.resultGraph ? s.resultGraph : s.graph,
    result: usable ? s.result : null,
    fleet: usable ? s.fleet : null,
    settings: usable ? s.resultSettings : null,
    source: s.resultSource,
  };
}

export function ExportSection() {
  const x = useExportInput();
  const navigate = useNavigate();
  const items = [
    { id: 'json', label: 'Scenario and result (JSON)', note: 'Graph, settings, provenance, single route and fleet routes; re-importable.', run: () => downloadJson(x), enabled: true },
    { id: 'route-csv', label: 'Route steps (CSV)', note: 'One row per traversal: order, street, direction, kind, length, cumulative distance.', run: () => downloadRouteCsv(x), enabled: !!x.result },
    { id: 'streets-csv', label: 'Streets (CSV)', note: 'One row per street: required, one-way, traversals, added copies.', run: () => downloadStreetsCsv(x), enabled: !!x.result },
    { id: 'fleet-csv', label: 'Vehicle routes (CSV)', note: 'Every step of every vehicle, with each route’s validation status.', run: () => downloadFleetCsv(x), enabled: !!x.fleet },
    { id: 'geojson', label: 'Network (GeoJSON)', note: x.graph.vertices.every((v) => v.geo) ? 'WGS84 coordinates with per-street route statistics.' : 'Local planar coordinates (this network has no geographic positions).', run: () => downloadGeoJson(x), enabled: true },
  ];
  return (
    <section id="surface-export" className="surface" aria-labelledby="exp-h">
      <header className="surface__head">
        <p className="eyebrow">I · Report and export</p>
        <h2 id="exp-h" className="dim-title">Take the result with you.</h2>
        <p className="surface__lede muted">Exports are written from the same record you see above{x.graph.source?.attribution ? `, and carry the data attribution (${x.graph.source.attribution}, ${x.graph.source.license})` : ''}.</p>
      </header>
      <div className="export-grid">
        {items.map((it) => (
          <button key={it.id} type="button" className="export-item" onClick={it.run} disabled={!it.enabled} data-testid={`export-${it.id}`}>
            <Icon name="download" size={18} />
            <span>
              <strong>{it.label}</strong>
              <span className="small muted">{it.enabled ? it.note : it.id === 'fleet-csv' ? 'Plan with more than one vehicle first.' : 'Optimise first.'}</span>
            </span>
          </button>
        ))}
        <button
          type="button"
          className="export-item export-item--report"
          disabled={!x.result}
          onClick={() => {
            if (prepareReport(x)) navigate('/report');
            else toast.error('Could not prepare the report', 'Browser storage is unavailable.');
          }}
          data-testid="export-report"
        >
          <Icon name="export" size={18} />
          <span>
            <strong>Printable report</strong>
            <span className="small muted">{x.result ? 'Opens a print-ready page (use your browser’s Print to save a PDF).' : 'Optimise first.'}</span>
          </span>
        </button>
      </div>
    </section>
  );
}
