import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { DirectedOptimizationRecord, OptimizationRecord } from '@sweep/engine';
import { isOneway } from '@sweep/engine';
import { useWorkspace } from '../state/workspace';
import { useReducedMotion } from '../state/prefs';
import { webglAvailable, whenTextSettled } from '../lib/webgl';
import { WebGLBoundary } from '../components/WebGLBoundary';
import { formatDistance, formatNumber } from '../lib/format';
import { Icon } from '../components/Icon';
import { RouteProjection } from './RouteProjection';
import { PlaybackDeck } from './PlaybackDeck';
import { useRoute } from './useRouteData';
import { scrollToSurface } from './surfaces';

const DistrictScene = lazy(() => import('../three/DistrictScene'));

export const SOURCE_LABEL: Record<string, string> = {
  example: 'Bundled example',
  'bundled-sample': 'Real OSM sample (bundled)',
  'imported-file': 'Imported file',
  'live-acquisition': 'Live map acquisition',
  user: 'Edited network',
};

function FloatingInspector() {
  const { graph } = useRoute();
  const hover = useWorkspace((s) => s.hover);
  const selection = useWorkspace((s) => s.selection);
  const result = useWorkspace((s) => s.result);
  const stale = useWorkspace((s) => s.stale);
  const sel = selection ?? hover;
  const pinned = !!selection;
  const info = useMemo(() => {
    if (!sel) return null;
    const r = result && !stale ? result : null;
    if (sel.type === 'vertex') {
      const v = graph.vertices.find((x) => x.id === sel.id);
      if (!v) return null;
      const incident = graph.edges.filter((e) => e.u === v.id || e.v === v.id);
      const reqDeg = incident.reduce((s, e) => s + (e.required ? (e.u === e.v ? 2 : 1) : 0), 0);
      const visits = r ? r.route.steps.filter((st) => st.to === v.id).length : null;
      let partner: { id: string; distance: number } | null = null;
      let balance: { inR: number; outR: number; delta: number } | null = null;
      if (r && r.mode === 'directed') {
        const b = (r as DirectedOptimizationRecord).balance.find((x) => x.vertexId === v.id);
        if (b) balance = { inR: b.inRequired, outR: b.outRequired, delta: b.delta };
      } else if (r) {
        const p = (r as OptimizationRecord).matching.pairs.find((x) => x.a === v.id || x.b === v.id);
        if (p) partner = { id: p.a === v.id ? p.b : p.a, distance: p.distance };
      }
      return { kind: 'vertex' as const, v, incident, reqDeg, visits, partner, balance };
    }
    const e = graph.edges.find((x) => x.id === sel.id);
    if (!e) return null;
    const passes = r ? r.route.steps.filter((st) => st.edgeId === e.id) : [];
    return { kind: 'edge' as const, e, passes, oneway: isOneway(e) };
  }, [sel, graph, result, stale]);
  if (!info) return null;
  const ws = useWorkspace.getState();
  return (
    <aside className={`float-inspector${pinned ? ' is-pinned' : ''}`} aria-live="polite" data-testid="float-inspector">
      {info.kind === 'vertex' ? (
        <>
          <p className="eyebrow">Intersection{pinned ? '' : ' · hover'}</p>
          <h3 className="float-inspector__title">{info.v.label ?? info.v.id}</h3>
          <dl className="kv kv--tight">
            <dt>Required degree</dt>
            <dd className="mono">
              {info.reqDeg} {info.reqDeg % 2 === 1 ? <span className="chip chip--odd">odd</span> : <span className="chip">even</span>}
            </dd>
            {info.balance && (
              <>
                <dt>In / out (required)</dt>
                <dd className="mono">
                  {info.balance.inR} / {info.balance.outR} <span className={`chip${info.balance.delta !== 0 ? ' chip--warn' : ''}`}>δ {info.balance.delta > 0 ? `+${info.balance.delta}` : info.balance.delta}</span>
                </dd>
              </>
            )}
            <dt>Streets here</dt>
            <dd className="mono">{info.incident.length}</dd>
            {info.visits !== null && (
              <>
                <dt>Route arrivals</dt>
                <dd className="mono">{info.visits}×</dd>
              </>
            )}
            {info.partner && (
              <>
                <dt>Matched with</dt>
                <dd className="mono">
                  {info.partner.id} · {formatDistance(info.partner.distance)}
                </dd>
              </>
            )}
            {info.v.geo && (
              <>
                <dt>Position</dt>
                <dd className="mono">
                  {info.v.geo[1].toFixed(5)}, {info.v.geo[0].toFixed(5)}
                </dd>
              </>
            )}
          </dl>
          {pinned && (
            <div className="btn-row">
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => ws.cameraCommand('focus-node')} data-testid="inspector-focus">
                <Icon name="focus" size={13} /> Focus
              </button>
              {info.partner && (
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  onClick={() => {
                    ws.setAnalysisStep('matching');
                    ws.inspectBetween(info.v.id, info.partner!.id);
                  }}
                  data-testid="inspector-path"
                >
                  <Icon name="route" size={13} /> Shortest path
                </button>
              )}
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => scrollToSurface('editor')}>
                <Icon name="edit" size={13} /> Edit
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="eyebrow">Street{pinned ? '' : ' · hover'}</p>
          <h3 className="float-inspector__title">{info.e.name ?? info.e.id}</h3>
          <dl className="kv kv--tight">
            <dt>Length</dt>
            <dd className="mono">
              {formatDistance(info.e.weight)}
              {info.e.reverseWeight !== undefined && !info.oneway ? ` · back ${formatDistance(info.e.reverseWeight)}` : ''}
            </dd>
            <dt>Service</dt>
            <dd>{info.e.required ? <span className="chip chip--accent">required</span> : <span className="chip">optional</span>}{info.oneway ? <span className="chip">one-way {info.e.u}→{info.e.v}</span> : null}</dd>
            {info.passes.length > 0 && (
              <>
                <dt>Traversals</dt>
                <dd className="mono">
                  {info.passes.length}× {info.passes.filter((p) => p.kind === 'repeat').length > 0 ? <span className="chip chip--danger">{info.passes.filter((p) => p.kind === 'repeat').length} repeat</span> : null}
                  {info.passes.filter((p) => p.kind === 'deadhead').length > 0 ? <span className="chip chip--warn">deadhead</span> : null}
                </dd>
                <dt>Order</dt>
                <dd className="mono">{info.passes.map((p) => `#${p.index + 1}`).join(' ')}</dd>
              </>
            )}
            {info.e.sourceRef && (
              <>
                <dt>Source</dt>
                <dd className="mono">{info.e.sourceRef}</dd>
              </>
            )}
          </dl>
          {pinned && (
            <div className="btn-row">
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => ws.updateEdge(info.e.id, { required: !info.e.required })} data-testid="inspector-toggle-required">
                Mark {info.e.required ? 'optional' : 'required'}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => scrollToSurface('editor')}>
                <Icon name="edit" size={13} /> Edit
              </button>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

function CameraTools() {
  const selection = useWorkspace((s) => s.selection);
  const cmd = useWorkspace((s) => s.cameraCommand);
  return (
    <div className="cam-tools" role="toolbar" aria-label="Camera" aria-orientation="vertical">
      <button type="button" className="tool" onClick={() => cmd('reset')} aria-label="Reset camera" data-tip="Reset camera" data-testid="camera-reset">
        <Icon name="camera" size={16} />
      </button>
      <button type="button" className="tool" onClick={() => cmd('top')} aria-label="Top-down view" data-tip="Top-down view" data-testid="camera-top">
        <Icon name="top" size={16} />
      </button>
      <button type="button" className="tool" onClick={() => cmd('focus-route')} aria-label="Frame the route" data-tip="Frame the route" data-testid="camera-route">
        <Icon name="route" size={16} />
      </button>
      <button
        type="button"
        className="tool"
        onClick={() => cmd('focus-node')}
        disabled={selection?.type !== 'vertex'}
        aria-label="Focus the selected intersection"
        data-tip={selection?.type === 'vertex' ? 'Focus selected intersection' : 'Select an intersection to focus it'}
        data-testid="camera-node"
      >
        <Icon name="focus" size={16} />
      </button>
    </div>
  );
}

function Legend({ directed, fleet, attribution }: { directed: boolean; fleet: boolean; attribution: string | null }) {
  return (
    <div className="sim-legend" aria-label="Legend">
      <span>
        <i className="lg lg--spectral" /> {fleet ? 'Vehicle routes (tinted)' : 'Optimised route'}
      </span>
      <span>
        <i className="lg lg--repeat" /> Repeated traversal
      </span>
      <span>
        <i className="lg lg--deadhead" /> Deadhead (optional street)
      </span>
      <span>
        <i className="lg lg--required" /> Required street
      </span>
      {directed && (
        <span>
          <i className="lg lg--arrow">➜</i> One-way
        </span>
      )}
      <span className="faint" data-testid="sim-attribution">
        Buildings: procedural context · streets: {attribution ? `map data ${attribution}` : 'network data'}
      </span>
    </div>
  );
}

export function SimulationSection() {
  const data = useRoute();
  const { graph, theme, tracks3d, tracks2d, colors, district, highlight, fresh } = data;
  const reduced = useReducedMotion();
  const stage = useWorkspace((s) => s.stage);
  const name = useWorkspace((s) => s.name);
  const result = useWorkspace((s) => s.result);
  const fleet = useWorkspace((s) => s.fleet);
  const stale = useWorkspace((s) => s.stale);
  const failure = useWorkspace((s) => s.failure);
  const optimizing = useWorkspace((s) => s.optimizing);
  const error = useWorkspace((s) => s.error);
  const validation = useWorkspace((s) => s.validation);
  const analysisStep = useWorkspace((s) => s.analysisStep);
  const webgl = webglAvailable();
  const use3d = stage === '3d' && webgl;
  // Compile the 3D scene only once the page's web fonts are in: compiling it while text still waits on a font
  // can deadlock Chromium's renderer thread pool (docs/CITY_UX_NOTES.md §1).
  const [textSettled, setTextSettled] = useState(false);
  useEffect(() => {
    let live = true;
    void whenTextSettled().then(() => live && setTextSettled(true));
    return () => {
      live = false;
    };
  }, []);
  const ref = useWorkspace((s) => s.ref);
  const edited = useWorkspace((s) => s.networkEdited);
  const src = edited && graph.source?.kind !== 'live-acquisition' && graph.source?.kind !== 'bundled-sample' ? 'user' : (graph.source?.kind ?? (ref?.kind === 'example' ? 'example' : 'user'));
  const errors = (failure ?? validation).issues.filter((i) => i.severity === 'error');
  const directed = result?.mode === 'directed' || graph.edges.some(isOneway);
  return (
    <section id="surface-simulation" className="surface surface--sim" aria-labelledby="sim-title" data-bloom-zone data-petal-intensity="0.7">
      <div className="sim-stage" data-testid="sim-stage">
        {use3d ? (
          <WebGLBoundary fallback={<div className="stage-loading" role="status">The 3D view could not start on this device (WebGL is unavailable). Use the 2D stage.</div>}>
          <Suspense fallback={<div className="stage-loading" role="status">Building the district…</div>}>
            {textSettled ? <DistrictScene district={district} tracks={fresh ? tracks3d : []} trackColors={colors} theme={theme} reduced={reduced} highlight={highlight} dimRoute={analysisStep !== null && !highlight.showRoute} /> : <div className="stage-loading" role="status">Building the district…</div>}
          </Suspense>
          </WebGLBoundary>
        ) : (
          <RouteProjection
            graph={graph}
            tracks={fresh ? tracks2d : []}
            trackColors={colors}
            theme={theme}
            reduced={reduced}
            highlight={highlight.showRoute ? highlight : { ...highlight, showRoute: true }}
            depotId={result?.input.depotId ?? graph.depotId ?? null}
            label={`Two-dimensional map of ${name}: ${graph.vertices.length} intersections, ${graph.edges.length} streets.`}
            testId="sim-2d"
          />
        )}
        <div className="sim-head">
          <p className="eyebrow">B · Urban simulation · <span data-testid="sim-source">{SOURCE_LABEL[src] ?? 'Network'}</span></p>
          <h1 id="sim-title" className="dim-title dim-title--xl" data-testid="sim-title">
            {name}
          </h1>
          {result && fresh ? (
            <dl className="sim-metrics">
              <div>
                <dt>{fleet ? 'Longest route' : 'Route'}</dt>
                <dd className="num" data-testid="total-distance">{formatDistance(fleet ? fleet.makespan : result.route.totalDistance)}</dd>
              </div>
              <div>
                <dt>Required</dt>
                <dd className="num">{formatDistance(result.route.requiredDistance)}</dd>
              </div>
              <div>
                <dt>{fleet ? 'Extra driving (all vehicles)' : 'Repeated'}</dt>
                <dd className="num num--repeat">{formatDistance(fleet ? Math.max(0, fleet.totalDistance - result.route.requiredDistance) : result.route.repeatedDistance)}</dd>
              </div>
              <div>
                <dt>{fleet ? 'Vehicles' : 'Traversals'}</dt>
                <dd className="num">{fleet ? fleet.activeVehicles : formatNumber(result.route.steps.length)}</dd>
              </div>
              <div>
                <dt>Status</dt>
                {fleet ? (
                  <dd className={`status-pill${fleet.algorithm.ratioBound === 1 ? ' is-ok' : ''}`} data-testid="solver-status" title={fleet.algorithm.guarantee}>
                    {fleet.algorithm.ratioBound === 1 ? 'Exact' : fleet.algorithm.ratioBound ? `Within ${fleet.algorithm.ratioBound.toFixed(2)}× of optimal` : 'Heuristic split'} · {fleet.checks.every((c) => c.passed) ? 'verified' : 'check failed'}
                  </dd>
                ) : (
                  <dd className={`status-pill${result.algorithm.optimal ? ' is-ok' : ' is-bad'}`} data-testid="solver-status">
                    <Icon name={result.algorithm.optimal ? 'check' : 'cross'} size={13} />
                    {result.algorithm.optimal ? (result.mode === 'undirected' && result.algorithm.directionPolicy === 'oneway-ignored' ? 'Exact for two-way relaxation' : 'Exact · verified') : 'Not certified'}
                  </dd>
                )}
              </div>
            </dl>
          ) : null}
          {!webgl && stage === '3d' && <p className="notice notice--info small">WebGL is unavailable in this browser; the simulation is shown as a 2D projection.</p>}
        </div>
        {use3d && <CameraTools />}
        <FloatingInspector />
        {(optimizing || stale || errors.length > 0 || error) && (
          <div className={`sim-status${errors.length > 0 || error ? ' is-bad' : ''}`} role="status" data-testid="sim-status">
            {optimizing ? (
              <>
                <span className="spinner" aria-hidden="true" /> Computing the exact route…
              </>
            ) : error ? (
              <>Engine error: {error}</>
            ) : errors.length > 0 ? (
              <>
                <Icon name="info" size={14} /> {errors[0]!.message}{' '}
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => scrollToSurface('editor')}>
                  Open diagnostics
                </button>
              </>
            ) : (
              <>
                The network changed since this route was computed.{' '}
                <button type="button" className="btn btn--quiet btn--sm" onClick={() => void useWorkspace.getState().runOptimize()}>
                  Recalculate
                </button>
              </>
            )}
          </div>
        )}
        <Legend directed={directed} fleet={!!fleet} attribution={graph.source?.attribution ? `${graph.source.attribution}${graph.source.license ? ` (${graph.source.license})` : ''}` : null} />
        <div className="sim-deck">
          <PlaybackDeck />
        </div>
      </div>
    </section>
  );
}
