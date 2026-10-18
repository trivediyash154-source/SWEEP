import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Graph } from '@sweep/engine';
import { useWorkspace, type View } from '../state/workspace';
import { useAuth } from '../state/auth';
import { api, ApiRequestError } from '../lib/api';
import { listLocalScenarios, newId, saveLocalScenario } from '../lib/storage';
import { toast } from '../state/toasts';
import { Wordmark } from '../components/Wordmark';
import { ThemeToggle } from '../components/ThemeToggle';
import { Icon } from '../components/Icon';
import { NetworkCanvas } from './NetworkCanvas';
import { Inspector } from './Inspector';
import { ResultsPanel } from './ResultsPanel';
import { LibraryPanel } from './LibraryPanel';
import { ToolDock } from './ToolDock';
import { Legend } from './Legend';
import { ExplainBar } from './ExplainBar';
import { PlaybackBar } from './PlaybackBar';
import { routeClock } from './routeClock';
import { webglAvailable } from '../lib/webgl';
import '../styles/workspace.css';

const Route3D = lazy(() => import('./Route3D'));

const VIEWS: Array<{ id: View; label: string; key: string }> = [
  { id: 'compose', label: 'Compose', key: '1' },
  { id: 'explain', label: 'Explain', key: '2' },
  { id: 'fly', label: '3D route', key: '3' },
];

export default function Workspace() {
  const ws = useWorkspace();
  const auth = useAuth();
  const { scenarioId } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const [panel, setPanel] = useState<'inspect' | 'results'>('inspect');
  const [libraryOpen, setLibraryOpen] = useState(() => window.innerWidth > 1100);
  const [saving, setSaving] = useState(false);
  const [libRefresh, setLibRefresh] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---- load scenario from the URL ------------------------------------------
  useEffect(() => {
    const example = search.get('example');
    if (example && !scenarioId) {
      if (!(ws.ref?.kind === 'example' && ws.ref.id === example)) ws.loadExample(example);
      return;
    }
    if (!scenarioId) return;
    if (ws.ref?.id === scenarioId) return;
    if (scenarioId.startsWith('local-')) {
      const s = listLocalScenarios().find((x) => x.id === scenarioId);
      if (s) ws.loadGraph(s.graph, { kind: 'local', id: s.id }, s.name);
      else setLoadError('That saved scenario is not on this device.');
      return;
    }
    if (auth.status === 'unknown' || auth.status === 'loading') return;
    api<{ id: string; name: string; graph: Graph }>(`/scenarios/${scenarioId}`)
      .then((s) => {
        setLoadError(null);
        ws.loadGraph(s.graph, { kind: 'remote', id: s.id }, s.name);
      })
      .catch((e: ApiRequestError) => setLoadError(e.status === 401 ? 'Sign in to open this scenario.' : e.status === 404 ? 'Scenario not found, or it belongs to another account.' : e.message));
    // eslint-disable-next-line
  }, [scenarioId, search, auth.status]);

  // switch to results after a run
  useEffect(() => {
    if (ws.result || ws.failure) setPanel('results');
  }, [ws.result, ws.failure]);

  // stop playback when leaving
  useEffect(() => () => routeClock.pause(), []);

  // ---- keyboard shortcuts --------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"], .dialog')) return;
      const st = useWorkspace.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        st.redo();
        return;
      }
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        void st.runOptimize();
        return;
      }
      if (mod || e.altKey) return;
      const map: Record<string, () => void> = {
        v: () => st.setTool('select'),
        a: () => st.setTool('add'),
        c: () => st.setTool('connect'),
        r: () => st.setTool('required'),
        x: () => st.setTool('delete'),
        s: () => st.setTool('depot'),
        f: () => st.requestFit(),
        '1': () => st.setView('compose'),
        '2': () => st.setView('explain'),
        '3': () => st.setView('fly'),
        Escape: () => {
          st.setPendingConnect(null);
          st.select(null);
        },
        Delete: () => {
          if (st.selection?.type === 'vertex') st.removeVertex(st.selection.id);
          else if (st.selection?.type === 'edge') st.removeEdge(st.selection.id);
        },
        Backspace: () => map.Delete!(),
      };
      const fn = map[e.key] ?? map[e.key.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const save = async (): Promise<void> => {
    setSaving(true);
    const st = useWorkspace.getState();
    const graph = { ...st.graph, name: st.name };
    try {
      if (auth.status === 'signed-in') {
        if (st.ref?.kind === 'remote') {
          await api(`/scenarios/${st.ref.id}`, { method: 'PUT', body: { name: st.name, graph } });
          st.markSaved(st.ref);
        } else {
          const created = await api<{ id: string }>('/scenarios', { method: 'POST', body: { name: st.name, graph } });
          st.markSaved({ kind: 'remote', id: created.id });
          navigate(`/workspace/${created.id}`, { replace: true });
        }
        toast.success('Saved to your account', st.name);
      } else {
        const id = st.ref?.kind === 'local' ? st.ref.id : newId('local');
        if (!saveLocalScenario({ id, name: st.name, graph, updatedAt: Date.now() })) throw new Error('Browser storage is unavailable or full.');
        st.markSaved({ kind: 'local', id });
        navigate(`/workspace/${id}`, { replace: true });
        toast.success('Saved on this device', auth.status === 'signed-out' ? 'Sign in to keep scenarios in your account.' : undefined);
      }
      setLibRefresh((n) => n + 1);
    } catch (e) {
      toast.error('Could not save', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const savedLabel = ws.dirty ? 'Unsaved changes' : ws.ref?.kind === 'remote' ? 'Saved to account' : ws.ref?.kind === 'local' ? 'Saved on device' : ws.ref?.kind === 'example' ? 'Example' : 'Not saved';
  const canOptimize = ws.validation.ok && !ws.optimizing;

  return (
    <div className={`workspace view-${ws.view}${libraryOpen ? '' : ' library-closed'}`}>
      <header className="ws-header">
        <div className="ws-header__start">
          <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => setLibraryOpen(!libraryOpen)} aria-label={libraryOpen ? 'Hide library' : 'Show library'} aria-expanded={libraryOpen}>
            <Icon name="library" size={17} />
          </button>
          <Wordmark size="sm" />
          <span className="ws-header__sep" aria-hidden="true" />
          <input className="ws-name" value={ws.name} onChange={(e) => ws.setName(e.target.value.slice(0, 120))} aria-label="Scenario name" data-testid="scenario-name" />
          <span className={`chip${ws.dirty ? ' chip--warn' : ''} hide-md`}>{savedLabel}</span>
        </div>
        <div className="segmented ws-views" role="tablist" aria-label="Workspace view">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={ws.view === v.id} onClick={() => ws.setView(v.id)} data-testid={`view-${v.id}`}>
              {v.label}
            </button>
          ))}
        </div>
        <div className="ws-header__end">
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => void save()} disabled={saving} data-testid="save">
            {saving ? <span className="spinner" aria-hidden="true" /> : <Icon name="save" size={14} />} Save
          </button>
          <ThemeToggle compact />
          {auth.status === 'signed-in' ? (
            <Link to="/account" className="btn btn--ghost btn--sm" aria-label="Account">
              <Icon name="user" size={15} /> <span className="hide-md">{auth.user?.displayName}</span>
            </Link>
          ) : auth.status === 'signed-out' ? (
            <Link to="/signin" className="btn btn--ghost btn--sm">
              Sign in
            </Link>
          ) : null}
        </div>
      </header>

      {libraryOpen && <LibraryPanel refreshKey={libRefresh} />}

      <main id="main" className="ws-stage">
        {loadError && (
          <div className="notice notice--warn ws-stage__notice" role="alert">
            {loadError}
          </div>
        )}
        {ws.view === 'fly' ? (
          webglAvailable() ? (
            <Suspense fallback={<div className="stage-loading" role="status">Building the 3D district…</div>}>
              <Route3D />
            </Suspense>
          ) : (
            <div className="stage-fallback">
              <NetworkCanvas />
              <p className="notice notice--info stage-fallback__msg">WebGL is not available in this browser, so the route is shown in 2D.</p>
            </div>
          )
        ) : (
          <NetworkCanvas />
        )}
        {ws.view === 'compose' && <ToolDock />}
        {ws.view !== 'fly' && <Legend explain={ws.view === 'explain'} />}
        {ws.graph.vertices.length === 0 && ws.view === 'compose' && (
          <div className="stage-empty">
            <h2>An empty district.</h2>
            <p className="muted">
              Click to add intersections (<span className="kbd">A</span>), then join them with streets (<span className="kbd">C</span>). Or load an example from the library.
            </p>
          </div>
        )}
        <div className="ws-bottom">{ws.view === 'explain' ? <ExplainBar /> : <PlaybackBar />}</div>
      </main>

      <aside className="ws-side" aria-label="Inspector and results">
        <div className="ws-optimize">
          <button
            type="button"
            className={`btn btn--primary btn--lg btn--block${canOptimize ? ' btn--spectral' : ''}`}
            onClick={() => void ws.runOptimize()}
            disabled={!canOptimize}
            aria-describedby="optimize-hint"
            data-testid="optimize"
          >
            {ws.optimizing ? <span className="spinner" aria-hidden="true" /> : <Icon name="route" size={18} />}
            {ws.optimizing ? 'Optimising…' : ws.result && !ws.stale ? 'Re-optimize route' : 'Optimize route'}
          </button>
          <p id="optimize-hint" className="faint small ws-optimize__hint">
            {ws.validation.ok ? (
              <>
                Exact Chinese Postman solution · <span className="kbd">Ctrl</span>+<span className="kbd">Enter</span>
              </>
            ) : (
              'Resolve the diagnostics below to enable optimisation.'
            )}
          </p>
        </div>
        <div className="segmented ws-side__tabs" role="tablist" aria-label="Side panel">
          <button type="button" role="tab" aria-selected={panel === 'inspect'} onClick={() => setPanel('inspect')}>
            Inspect
          </button>
          <button type="button" role="tab" aria-selected={panel === 'results'} onClick={() => setPanel('results')} data-testid="tab-results">
            Results{ws.result && !ws.stale ? ' ●' : ''}
          </button>
        </div>
        <div className="ws-side__body">{panel === 'inspect' ? <Inspector /> : <ResultsPanel />}</div>
      </aside>
    </div>
  );
}
