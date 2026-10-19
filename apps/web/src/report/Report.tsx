import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { DirectedOptimizationRecord, FleetRecord, Graph, OptimizationRecord, RoutingSettings, SingleRouteRecord } from '@sweep/engine';
import { api } from '../lib/api';
import { readJson } from '../lib/storage';
import { REPORT_KEY } from '../lib/exports';
import { normalizeRecord } from '../lib/analysis';
import { StaticNetwork } from '../landing/StaticNetwork';
import { Wordmark } from '../components/Wordmark';
import { formatDistance, formatMs, formatNumber, formatPercent } from '../lib/format';
import '../styles/report.css';

interface ReportData {
  name: string;
  graph: Graph;
  result: SingleRouteRecord;
  fleet?: FleetRecord | null;
  settings?: Required<RoutingSettings> | null;
  source: string | null;
  savedAt: number;
}

/** Printable optimisation report. Every value is read from the stored engine record. */
export default function Report() {
  const { runId } = useParams();
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (runId) {
      api<{ scenarioName: string; graph: Graph; record: SingleRouteRecord; routing?: { fleet: FleetRecord | null; settings: Required<RoutingSettings> }; createdAt: number }>(`/runs/${runId}`)
        .then((r) =>
          setData({ name: r.scenarioName, graph: r.graph, result: normalizeRecord(r.record), fleet: r.routing?.fleet ?? null, settings: r.routing?.settings ?? null, source: 'server', savedAt: r.createdAt }),
        )
        .catch((e: Error) => setError(e.message));
    } else {
      const d = readJson<ReportData | null>(REPORT_KEY, null);
      if (d && d.result && d.graph) setData({ ...d, result: normalizeRecord(d.result) });
      else setError('No optimisation result to report yet. Optimise a network in the workspace first.');
    }
  }, [runId]);

  if (error) {
    return (
      <main id="main" className="report report--empty">
        <Wordmark size="sm" />
        <p>{error}</p>
        <Link className="btn btn--quiet" to="/workspace">
          Open the workspace
        </Link>
      </main>
    );
  }
  if (!data) return <main id="main" className="report report--empty" role="status">Loading report…</main>;

  const r = data.result;
  const u = r.mode === 'directed' ? null : (r as OptimizationRecord);
  const d = r.mode === 'directed' ? (r as DirectedOptimizationRecord) : null;
  const fleet = data.fleet ?? null;
  const names = new Map(data.graph.edges.map((e) => [e.id, e.name ?? '']));
  const passed = r.checks.filter((c) => c.passed).length;
  const src = data.graph.source;

  return (
    <main id="main" className="report" data-testid="report">
      <div className="report__actions no-print">
        <Link to="/workspace" className="btn btn--ghost btn--sm">
          ← Workspace
        </Link>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => window.print()} data-testid="print-report">
          Print / save as PDF
        </button>
      </div>
      <header className="report__head">
        <Wordmark size="sm" to={null} />
        <div>
          <p className="eyebrow">Route optimisation report</p>
          <h1>{data.name}</h1>
          <p className="muted small">
            Generated {new Date(data.savedAt).toLocaleString()} · engine {r.engine.version} · {data.source === 'server' ? 'server computation' : 'in-browser computation'} · input hash <span className="mono">{r.input.graphHash.slice(0, 16)}…</span>
          </p>
          {src?.attribution && (
            <p className="muted small">
              Map data {src.attribution} ({src.license}) · {src.provider}
              {src.retrievedAt ? ` · retrieved ${new Date(src.retrievedAt).toLocaleString()}` : ''}
            </p>
          )}
        </div>
      </header>

      <section className="report__summary">
        <div>
          <span className="report__k">{d ? 'Optimal legal closed route' : 'Optimal closed route'}</span>
          <span className="report__v num">{formatDistance(r.route.totalDistance)}</span>
        </div>
        <div>
          <span className="report__k">Required streets</span>
          <span className="report__v num">{formatDistance(r.route.requiredDistance)}</span>
        </div>
        <div>
          <span className="report__k">Repeated distance</span>
          <span className="report__v num">
            {formatDistance(r.route.repeatedDistance)} <small>({formatPercent(r.route.totalDistance ? r.route.repeatedDistance / r.route.totalDistance : 0)})</small>
          </span>
        </div>
        <div>
          <span className="report__k">Verification</span>
          <span className="report__v">
            {passed}/{r.checks.length} checks · {r.algorithm.optimal ? 'certified optimal' : 'not certified'}
          </span>
        </div>
      </section>

      <figure className="report__figure">
        <StaticNetwork graph={data.graph} result={r} overlay="route" assumedWidth={900} showWeights={data.graph.edges.length <= 60} showLabels={data.graph.vertices.length <= 30} label={`Route map for ${data.name}`} />
        <figcaption className="small muted">Cyan: optimised route. Coral: repeated required streets. Dashed coral: optional streets driven to reposition. Lavender rings: odd-degree intersections. Diamond: start.</figcaption>
      </figure>

      <section className="report__cols">
        <div>
          <h2>Input</h2>
          <table className="table">
            <tbody>
              <tr><th scope="row">Intersections</th><td className="num">{formatNumber(r.input.vertexCount)}</td></tr>
              <tr><th scope="row">Streets</th><td className="num">{formatNumber(r.input.edgeCount)}</td></tr>
              <tr><th scope="row">Required / optional</th><td className="num">{r.input.requiredEdgeCount} / {r.input.optionalEdgeCount}</td></tr>
              {u && <tr><th scope="row">Odd-degree intersections</th><td className="num">{u.oddVertexIds.length}</td></tr>}
              {d && <tr><th scope="row">One-way streets</th><td className="num">{d.input.onewayEdgeCount}</td></tr>}
              {d && <tr><th scope="row">Imbalanced intersections</th><td className="num">{d.imbalancedVertexIds.length}</td></tr>}
              <tr><th scope="row">Start</th><td className="num mono">{r.input.depotId}</td></tr>
            </tbody>
          </table>
        </div>
        <div>
          <h2>Comparison</h2>
          <table className="table">
            <tbody>
              <tr><th scope="row">SWEEP optimal</th><td className="num">{formatDistance(r.route.totalDistance)}</td></tr>
              {r.baselines.map((b) => (
                <tr key={b.id}>
                  <th scope="row">
                    {b.label} <span className="faint small">{b.isValidRoute ? '(valid route)' : '(bound)'}</span>
                  </th>
                  <td className="num">{b.total === null ? '—' : formatDistance(b.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Algorithm</h2>
        {u ? (
          <p className="small">
            {u.algorithm.problem === 'undirected-chinese-postman' ? 'Undirected Chinese Postman Problem' : 'Undirected postman problem with optional streets (required streets connected)'}
            {u.algorithm.directionPolicy === 'oneway-ignored' ? ' (one-way streets treated as two-way: a relaxation)' : ''}. Shortest paths: Dijkstra. Matching: {u.algorithm.matching === 'none' ? 'not needed (already Eulerian)' : "Edmonds' blossom algorithm"}
            {u.algorithm.matchingCrossCheck === 'subset-dp' ? ', cross-checked by exhaustive subset DP' : ''}. Euler circuit: Hierholzer. {u.algorithm.optimalityBasis}
          </p>
        ) : (
          <p className="small">
            {d!.algorithm.problem === 'mixed-chinese-postman-exact-enumeration' ? 'Mixed Chinese Postman Problem (two-way streets in either direction), solved exactly by enumerating service directions' : 'Directed Chinese Postman Problem (one-way streets forwards only; two-way streets in both directions)'}. Balancing: minimum-cost flow by successive shortest paths. Euler circuit: Hierholzer (directed). {d!.algorithm.optimalityBasis}
          </p>
        )}
        {u && u.matching.pairs.length > 0 && (
          <table className="table">
            <caption className="small muted">Matched odd intersections ({u.matching.pairs.length} pairs, total {formatDistance(u.matching.cost)}{u.matching.optimalPairingCount && u.matching.optimalPairingCount > 1 ? `; ${u.matching.optimalPairingCount} equally optimal pairings exist` : ''})</caption>
            <thead>
              <tr>
                <th>Pair</th>
                <th className="num">Shortest path</th>
                <th>Duplicated streets</th>
              </tr>
            </thead>
            <tbody>
              {u.matching.pairs.slice(0, 40).map((p) => (
                <tr key={`${p.a}-${p.b}`}>
                  <td className="mono">
                    {p.a} ↔ {p.b}
                  </td>
                  <td className="num">{formatDistance(p.distance)}</td>
                  <td className="small">{p.pathEdgeIds.map((id) => names.get(id) || id).join(' → ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {d && d.flow.paths.length > 0 && (
          <table className="table">
            <caption className="small muted">Balancing flow ({d.flow.totalUnits} units, cost {formatDistance(d.flow.cost)}; certificate {d.flow.dualCertificateVerified ? 'verified' : 'failed'})</caption>
            <thead>
              <tr>
                <th>From → to</th>
                <th className="num">Units</th>
                <th className="num">Length</th>
                <th>Streets</th>
              </tr>
            </thead>
            <tbody>
              {d.flow.paths.slice(0, 40).map((p, i) => (
                <tr key={i}>
                  <td className="mono">{p.from} → {p.to}</td>
                  <td className="num">{p.units}</td>
                  <td className="num">{formatDistance(p.distance)}</td>
                  <td className="small">{p.pathEdgeIds.map((id) => names.get(id) || id).join(' → ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {fleet && (
        <section>
          <h2>Fleet ({fleet.activeVehicles} of {fleet.vehicles} vehicles)</h2>
          <p className="small">{fleet.algorithm.guarantee}</p>
          <table className="table">
            <thead>
              <tr>
                <th>Vehicle</th>
                <th className="num">Length</th>
                <th className="num">Approach</th>
                <th className="num">Return</th>
                <th className="num">Streets serviced</th>
                <th>Valid</th>
              </tr>
            </thead>
            <tbody>
              {fleet.routes.map((v) => (
                <tr key={v.vehicle}>
                  <td>V{v.vehicle}</td>
                  <td className="num">{formatDistance(v.distance)}</td>
                  <td className="num">{formatDistance(v.approachDistance)}</td>
                  <td className="num">{formatDistance(v.returnDistance)}</td>
                  <td className="num">{v.servicedEdgeIds.length}</td>
                  <td>{v.checks.every((c) => c.passed) ? '✓' : '✗'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">
            Longest route {formatDistance(fleet.makespan)} (lower bound {formatDistance(fleet.lowerBound.value)}); total fleet distance {formatDistance(fleet.totalDistance)} vs single route {formatDistance(fleet.singleVehicleDistance)}.
          </p>
        </section>
      )}

      <section>
        <h2>Verification</h2>
        <ul className="report__checks">
          {r.checks.map((c) => (
            <li key={c.id}>
              <span className={c.passed ? 'ok' : 'bad'}>{c.passed ? '✓' : '✗'}</span> <strong>{c.label}.</strong> <span className="muted">{c.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Route ({r.route.steps.length} steps)</h2>
        <table className="table report__steps">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>Street</th>
              <th>From → to</th>
              <th>Kind</th>
              <th className="num">Length</th>
              <th className="num">Cumulative</th>
            </tr>
          </thead>
          <tbody>
            {r.route.steps.slice(0, 250).map((s) => (
              <tr key={s.index}>
                <td className="num">{s.index + 1}</td>
                <td>{names.get(s.edgeId) || s.edgeId}</td>
                <td className="mono small">
                  {s.from} → {s.to}
                </td>
                <td>{s.kind}</td>
                <td className="num">{formatDistance(s.weight, { precise: true })}</td>
                <td className="num">{formatDistance(s.cumulative, { precise: true })}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {r.route.steps.length > 250 && <p className="small muted">Showing the first 250 of {r.route.steps.length} steps. Export the route CSV from the workspace for the full list.</p>}
      </section>

      <section>
        <h2>Assumptions and limitations</h2>
        <ul className="small">
          {d ? (
            <li>One-way streets are driven only in their permitted direction; two-way streets are serviced {d.algorithm.twoWay === 'both' ? 'once in each direction' : 'once in either direction'}. Turn costs are not modelled.</li>
          ) : (
            <li>Streets may be driven in either direction{u?.algorithm.directionPolicy === 'oneway-ignored' ? ' (one-way restrictions were ignored by request; this route may not be legal)' : ''}; turn costs are not modelled.</li>
          )}
          <li>{fleet ? `${fleet.activeVehicles} closed routes from one shared depot; no capacity or time-window constraints.` : 'A single closed route from the start back to it; no capacity or time-window constraints.'}</li>
          <li>Street lengths are the values in the input; the result is optimal for those values.</li>
          <li>Computation time: {formatMs(r.timingsMs.total)} on the computing device.</li>
        </ul>
      </section>
    </main>
  );
}
