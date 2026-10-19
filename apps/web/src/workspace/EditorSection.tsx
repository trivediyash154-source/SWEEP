import { useState } from 'react';
import { isOneway, MAX_VEHICLES, type Graph } from '@sweep/engine';
import { useWorkspace, routingOf } from '../state/workspace';
import { formatDistance } from '../lib/format';
import { toast } from '../state/toasts';
import { Icon } from '../components/Icon';
import { NetworkCanvas } from './NetworkCanvas';
import { ToolDock } from './ToolDock';
import { Inspector } from './Inspector';
import { LibraryPanel } from './LibraryPanel';
import { ImportDialog } from './ImportDialog';
import { MapAcquireDialog } from './MapAcquireDialog';
import { StreetsDialog } from './StreetsDialog';

/** Scenario routing configuration: problem variant, service rule and fleet. Stored with the network. */
export function RoutingPanel() {
  const graph = useWorkspace((s) => s.graph);
  const failure = useWorkspace((s) => s.failure);
  const fleetIssues = useWorkspace((s) => s.fleetIssues);
  const setRouting = useWorkspace((s) => s.setRouting);
  const r = routingOf(graph);
  const oneways = graph.edges.filter(isOneway).length;
  const infeasible = failure?.issues.find((i) => i.code === 'DIRECTED_INFEASIBLE');
  const [limitDraft, setLimitDraft] = useState<string | null>(null);
  return (
    <div className="routing-panel" data-testid="routing-panel">
      <h3 className="panel-title">Routing problem</h3>
      <div className="field">
        <span className="field__label">Street directions</span>
        <div className="segmented" role="group" aria-label="Routing mode">
          <button type="button" aria-pressed={r.mode === 'undirected'} onClick={() => setRouting({ mode: 'undirected' })} data-testid="mode-undirected">
            Undirected
          </button>
          <button type="button" aria-pressed={r.mode === 'directed'} onClick={() => setRouting({ mode: 'directed' })} data-testid="mode-directed">
            Directed (one-way)
          </button>
        </div>
        <p className="faint small">
          {r.mode === 'undirected'
            ? 'Every street may be driven either way. Exact: Edmonds–Johnson with a minimum-weight perfect matching.'
            : 'One-way streets only forwards. Exact: minimum-cost flow balances in- and out-degrees, then a directed Euler circuit.'}{' '}
          {oneways > 0 ? `${oneways} one-way street${oneways === 1 ? '' : 's'} in this network.` : 'No one-way streets in this network.'}
        </p>
      </div>
      {r.mode === 'undirected' && oneways > 0 && (
        <label className="switch">
          <input type="checkbox" checked={r.ignoreOneway} onChange={(e) => setRouting({ ignoreOneway: e.target.checked })} data-testid="ignore-oneway" />
          <span className="switch__track" aria-hidden="true" />
          Treat one-way streets as two-way (relaxation, may break one-way rules)
        </label>
      )}
      {r.mode === 'directed' && (
        <div className="field">
          <span className="field__label">Two-way streets must be serviced</span>
          <div className="segmented" role="group" aria-label="Two-way service rule">
            <button type="button" aria-pressed={r.twoWay === 'both'} onClick={() => setRouting({ twoWay: 'both' })} data-testid="twoway-both">
              In both directions
            </button>
            <button type="button" aria-pressed={r.twoWay === 'either'} onClick={() => setRouting({ twoWay: 'either' })} data-testid="twoway-either">
              In either direction
            </button>
          </div>
          <p className="faint small">
            {r.twoWay === 'both'
              ? 'Each kerb is a separate obligation (typical for sweeping). Solved exactly for any size.'
              : 'The mixed postman problem (NP-hard). Solved exactly by checking every service direction, up to 12 required two-way streets.'}
          </p>
        </div>
      )}
      {infeasible && (
        <div className="notice notice--warn small" role="alert">
          <p>{infeasible.message}</p>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={() => {
              const ids = new Set(infeasible.edgeIds ?? []);
              const st = useWorkspace.getState();
              for (const id of ids) st.updateEdge(id, { required: false });
              toast.info(`${ids.size} streets marked optional`, 'They remain in the network for driving but are no longer serviced.');
            }}
            data-testid="fix-infeasible"
          >
            Mark these {infeasible.edgeIds?.length ?? 0} streets optional
          </button>
        </div>
      )}
      <div className="field">
        <span className="field__label">Vehicles from the start point</span>
        <div className="stepper">
          <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => setRouting({ vehicles: Math.max(1, r.vehicles - 1) })} disabled={r.vehicles <= 1} aria-label="One fewer vehicle">
            −
          </button>
          <input
            className="input input--mono stepper__value"
            type="number"
            min={1}
            max={MAX_VEHICLES}
            value={r.vehicles}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (Number.isFinite(v)) setRouting({ vehicles: Math.max(1, Math.min(MAX_VEHICLES, v)) });
            }}
            aria-label="Number of vehicles"
            data-testid="vehicles-input"
          />
          <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => setRouting({ vehicles: Math.min(MAX_VEHICLES, r.vehicles + 1) })} disabled={r.vehicles >= MAX_VEHICLES} aria-label="One more vehicle">
            +
          </button>
        </div>
      </div>
      {r.vehicles > 1 && (
        <>
          <div className="field">
            <span className="field__label">Fleet objective</span>
            <div className="segmented" role="group" aria-label="Fleet objective">
              <button type="button" aria-pressed={r.objective === 'balance'} onClick={() => setRouting({ objective: 'balance' })} data-testid="objective-balance">
                Shortest longest route
              </button>
              <button type="button" aria-pressed={r.objective === 'total'} onClick={() => setRouting({ objective: 'total' })} data-testid="objective-total">
                Least total distance
              </button>
            </div>
            <p className="faint small">
              {r.objective === 'balance'
                ? r.mode === 'directed'
                  ? 'Split of the certified route; heuristic for one-way networks (no proven ratio), lower bound shown.'
                  : 'Split of the certified route; the longest route is within (2 − 1/k) of the optimum.'
                : 'Without a route limit one vehicle is optimal for total distance; set a limit to share the work.'}
            </p>
          </div>
          <label className="field">
            <span className="field__label">Route length limit per vehicle (optional)</span>
            <input
              className="input input--mono"
              inputMode="decimal"
              placeholder="no limit"
              value={limitDraft ?? (r.maxRouteLength === null ? '' : String(r.maxRouteLength))}
              onChange={(e) => setLimitDraft(e.target.value)}
              onBlur={() => {
                if (limitDraft === null) return;
                const v = Number(limitDraft);
                setRouting({ maxRouteLength: limitDraft.trim() === '' || !Number.isFinite(v) || v <= 0 ? null : v });
                setLimitDraft(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              data-testid="route-limit"
            />
          </label>
          {fleetIssues.length > 0 && (
            <p className="notice notice--warn small" role="alert" data-testid="fleet-issue">
              {fleetIssues[0]!.message} The single-vehicle route is still shown.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function EditorSection() {
  const graph = useWorkspace((s) => s.graph);
  const optimizing = useWorkspace((s) => s.optimizing);
  const autoSolve = useWorkspace((s) => s.autoSolve);
  const canUndo = useWorkspace((s) => s.history.length > 0);
  const canRedo = useWorkspace((s) => s.future.length > 0);
  const valid = useWorkspace((s) => s.validation.ok);
  const [dialog, setDialog] = useState<'import' | 'map' | 'streets' | null>(null);
  const ws = useWorkspace.getState();
  return (
    <section id="surface-editor" className="surface surface--editor" aria-labelledby="edit-h">
      <header className="surface__head">
        <p className="eyebrow">F · Network editing laboratory</p>
        <h2 id="edit-h" className="dim-title">Shape the network.</h2>
        <p className="surface__lede muted">Add and move intersections, draw streets, set lengths, required service and one-way directions. Every change revalidates instantly{autoSolve ? ' and re-solves automatically' : ''}; the city, projection and analysis above follow.</p>
      </header>
      <div className="editor-bar" role="toolbar" aria-label="Editor actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={ws.undo} disabled={!canUndo} data-testid="undo">
          <Icon name="undo" size={14} /> Undo
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={ws.redo} disabled={!canRedo} data-testid="redo">
          <Icon name="redo" size={14} /> Redo
        </button>
        <span className="editor-bar__sep" aria-hidden="true" />
        <button type="button" className="btn btn--quiet btn--sm" onClick={() => void ws.runOptimize()} disabled={!valid || optimizing} data-testid="recalculate">
          {optimizing ? <span className="spinner" aria-hidden="true" /> : <Icon name="route" size={14} />} Recalculate
        </button>
        <label className="switch switch--sm">
          <input type="checkbox" checked={autoSolve} onChange={(e) => ws.setAutoSolve(e.target.checked)} data-testid="auto-solve" />
          <span className="switch__track" aria-hidden="true" />
          Auto-solve
        </label>
        <span className="editor-bar__sep" aria-hidden="true" />
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDialog('import')} data-testid="open-import-bar">
          <Icon name="import" size={14} /> Import GeoJSON / JSON
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDialog('map')} data-testid="open-map">
          <Icon name="map" size={14} /> Acquire map
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDialog('streets')} data-testid="open-streets">
          <Icon name="table" size={14} /> Streets table
        </button>
        <span className="editor-bar__meta faint small mono">
          {graph.vertices.length} intersections · {graph.edges.length} streets · {formatDistance(graph.edges.filter((e) => e.required).reduce((s, e) => s + e.weight, 0))} required
        </span>
      </div>
      <div className="editor-grid">
        <LibraryPanel refreshKey={0} />
        <div className="editor-stage" data-petal-intensity="0.2">
          <NetworkCanvas />
          <ToolDock />
          {graph.vertices.length === 0 && (
            <div className="stage-empty">
              <h3>An empty district.</h3>
              <p className="muted">
                Click to add intersections (<span className="kbd">A</span>), then join them with streets (<span className="kbd">C</span>). Or load a network from the library.
              </p>
            </div>
          )}
        </div>
        <aside className="editor-side" aria-label="Inspector and routing">
          <RoutingPanel />
          <Inspector />
        </aside>
      </div>
      {dialog === 'import' && <ImportDialog onClose={() => setDialog(null)} />}
      {dialog === 'streets' && <StreetsDialog onClose={() => setDialog(null)} />}
      <MapAcquireDialog
        open={dialog === 'map'}
        onClose={() => setDialog(null)}
        onLoad={(g: Graph) => {
          useWorkspace.getState().loadGraph(g, { kind: 'acquired', id: 'acquired' }, g.name ?? 'Acquired network');
          setDialog(null);
          toast.success('Map loaded', `${g.vertices.length} intersections · ${g.edges.length} streets · © OpenStreetMap contributors`);
        }}
      />
    </section>
  );
}
