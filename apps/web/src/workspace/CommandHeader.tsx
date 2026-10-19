import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { isOneway } from '@sweep/engine';
import { useWorkspace, routingOf } from '../state/workspace';
import { usePrefs, useReducedMotion } from '../state/prefs';
import { useAuth } from '../state/auth';
import { Wordmark } from '../components/Wordmark';
import { ThemeToggle } from '../components/ThemeToggle';
import { Icon } from '../components/Icon';
import { formatDistance } from '../lib/format';
import { downloadFleetCsv, downloadGeoJson, downloadJson, downloadRouteCsv, downloadStreetsCsv, prepareReport } from '../lib/exports';
import { toast } from '../state/toasts';
import { routeClock } from './routeClock';
import { SURFACES, scrollToSurface, type SurfaceId } from './surfaces';
import { useExportInput } from './ReportSections';
import { SOURCE_LABEL } from './SimulationSection';

function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function ExportMenu() {
  const m = useMenu();
  const x = useExportInput();
  const navigate = useNavigate();
  const item = (label: string, fn: () => void, enabled = true, id?: string) => (
    <button
      type="button"
      role="menuitem"
      disabled={!enabled}
      onClick={() => {
        fn();
        m.setOpen(false);
      }}
      data-testid={id}
    >
      {label}
    </button>
  );
  return (
    <div className="menu" ref={m.ref}>
      <button type="button" className="btn btn--ghost btn--sm" aria-haspopup="menu" aria-expanded={m.open} aria-label="Export" onClick={() => m.setOpen(!m.open)} data-testid="export-menu">
        <Icon name="export" size={14} /> <span className="hide-xl">Export</span>
      </button>
      {m.open && (
        <div className="menu__pop" role="menu">
          {item('Scenario + result (JSON)', () => downloadJson(x), true, 'menu-export-json')}
          {item('Route steps (CSV)', () => downloadRouteCsv(x), !!x.result, 'menu-export-route')}
          {item('Streets (CSV)', () => downloadStreetsCsv(x), !!x.result)}
          {item('Vehicle routes (CSV)', () => downloadFleetCsv(x), !!x.fleet)}
          {item('Network (GeoJSON)', () => downloadGeoJson(x))}
          {item('Printable report', () => (prepareReport(x) ? navigate('/report') : toast.error('Could not prepare the report')), !!x.result)}
        </div>
      )}
    </div>
  );
}

function ViewMenu() {
  const m = useMenu();
  const motion = usePrefs((s) => s.motion);
  const petals = usePrefs((s) => s.petals);
  const auth = useAuth();
  return (
    <div className="menu" ref={m.ref}>
      <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-haspopup="menu" aria-expanded={m.open} aria-label="View and account options" onClick={() => m.setOpen(!m.open)} data-testid="view-menu">
        <Icon name="menu" size={16} />
      </button>
      {m.open && (
        <div className="menu__pop menu__pop--right" role="menu">
          <label className="switch" role="menuitemcheckbox" aria-checked={motion === 'reduced'}>
            <input type="checkbox" checked={motion === 'reduced'} onChange={(e) => usePrefs.getState().setMotion(e.target.checked ? 'reduced' : 'system')} data-testid="toggle-motion" />
            <span className="switch__track" aria-hidden="true" />
            Pause motion
          </label>
          <label className="switch" role="menuitemcheckbox" aria-checked={petals}>
            <input type="checkbox" checked={petals} onChange={(e) => usePrefs.getState().setPetals(e.target.checked)} data-testid="toggle-petals" />
            <span className="switch__track" aria-hidden="true" />
            Blossom cursor
          </label>
          <hr />
          {auth.status === 'signed-in' ? (
            <Link to="/account" role="menuitem">Account ({auth.user?.displayName})</Link>
          ) : auth.status === 'signed-out' ? (
            <Link to="/signin" role="menuitem">Sign in (optional, to sync scenarios)</Link>
          ) : (
            <span className="faint small">Local-only build</span>
          )}
          <Link to="/mathematics" role="menuitem">About the mathematics</Link>
        </div>
      )}
    </div>
  );
}

/** A compact progress ring next to the play button, driven by the shared playback clock. */
function MiniPlayer() {
  const playing = useWorkspace((s) => s.playing);
  const fresh = useWorkspace((s) => !!s.result && !s.stale);
  const reduced = useReducedMotion();
  const ring = useRef<SVGCircleElement>(null);
  useEffect(
    () =>
      routeClock.subscribe((s) => {
        const f = routeClock.total > 0 && (s > 0 || routeClock.playing) ? Math.min(1, s / routeClock.total) : 0;
        if (ring.current) ring.current.style.strokeDashoffset = String(100 - f * 100);
      }),
    [],
  );
  return (
    <button
      type="button"
      className="mini-player"
      disabled={!fresh}
      aria-label={playing ? 'Pause playback' : 'Play the route'}
      onClick={() => {
        if (routeClock.playing) {
          routeClock.pause();
          useWorkspace.getState().setPlaying(false);
        } else if (reduced) routeClock.seek(routeClock.total);
        else {
          routeClock.play();
          useWorkspace.getState().setPlaying(true);
        }
      }}
      data-testid="header-play"
    >
      <svg viewBox="0 0 36 36" className="mini-player__ringsvg" aria-hidden="true">
        <circle cx="18" cy="18" r="15.9" className="mini-player__track" />
        <circle ref={ring} cx="18" cy="18" r="15.9" className="mini-player__ring" pathLength={100} strokeDasharray="100" strokeDashoffset="100" />
      </svg>
      <Icon name={playing ? 'pause' : 'play'} size={13} />
    </button>
  );
}

export function CommandHeader() {
  const name = useWorkspace((s) => s.name);
  const graph = useWorkspace((s) => s.graph);
  const dirty = useWorkspace((s) => s.dirty);
  const ref = useWorkspace((s) => s.ref);
  const stage = useWorkspace((s) => s.stage);
  const result = useWorkspace((s) => s.result);
  const fleet = useWorkspace((s) => s.fleet);
  const stale = useWorkspace((s) => s.stale);
  const optimizing = useWorkspace((s) => s.optimizing);
  const valid = useWorkspace((s) => s.validation.ok);
  const routing = routingOf(graph);
  const [active, setActive] = useState<SurfaceId>('simulation');
  const hasOneway = graph.edges.some(isOneway);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActive(vis[0].target.id.replace('surface-', '') as SurfaceId);
      },
      { rootMargin: '-35% 0px -55% 0px' },
    );
    for (const s of SURFACES) {
      const el = document.getElementById(`surface-${s.id}`);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);

  const savedLabel = dirty ? 'Unsaved changes' : ref?.kind === 'local' ? 'Saved on device' : ref?.kind === 'remote' ? 'In account' : SOURCE_LABEL[graph.source?.kind ?? (ref?.kind === 'example' ? 'example' : 'user')] ?? 'Example';
  const ws = useWorkspace.getState();
  return (
    <header className="cmd" data-testid="command-header">
      <div className="cmd__row">
        <div className="cmd__id">
          <span className="cmd__home">
            <Wordmark size="sm" />
          </span>
          <span className="cmd__sep" aria-hidden="true" />
          <input className="cmd__name" value={name} onChange={(e) => ws.setName(e.target.value.slice(0, 120))} aria-label="Scenario name" data-testid="scenario-name" />
          <span className={`chip${dirty ? ' chip--warn' : ''} hide-xl`} data-testid="save-state">{savedLabel}</span>
        </div>
        <div className="cmd__controls">
          <div className="segmented segmented--sm" role="group" aria-label="Street directions">
            <button type="button" aria-pressed={routing.mode === 'undirected'} onClick={() => ws.setRouting({ mode: 'undirected' })} data-testid="hdr-mode-undirected" title={hasOneway ? 'This network has one-way streets' : undefined}>
              Undirected
            </button>
            <button type="button" aria-pressed={routing.mode === 'directed'} onClick={() => ws.setRouting({ mode: 'directed' })} data-testid="hdr-mode-directed">
              Directed
            </button>
          </div>
          <label className="cmd__fleet" title="Vehicles">
            <Icon name="truck" size={14} />
            <select className="select select--sm" value={routing.vehicles} onChange={(e) => ws.setRouting({ vehicles: Number(e.target.value) })} aria-label="Number of vehicles" data-testid="hdr-vehicles">
              {Array.from({ length: 12 }, (_, i) => i + 1).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <div className="segmented segmented--sm" role="group" aria-label="Simulation view">
            <button type="button" aria-pressed={stage === '3d'} onClick={() => ws.setStage('3d')} data-testid="stage-3d">
              3D
            </button>
            <button type="button" aria-pressed={stage === '2d'} onClick={() => ws.setStage('2d')} data-testid="stage-2d">
              2D
            </button>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              ws.setTool('select');
              scrollToSurface('editor');
            }}
            data-testid="hdr-edit"
            aria-label="Edit the network"
          >
            <Icon name="edit" size={14} /> <span className="hide-xl">Edit</span>
          </button>
          <button type="button" className={`btn btn--primary btn--sm${valid && !optimizing ? ' btn--spectral' : ''}`} onClick={() => void ws.runOptimize()} disabled={!valid || optimizing} data-testid="optimize">
            {optimizing ? <span className="spinner" aria-hidden="true" /> : <Icon name="route" size={14} />}
            {optimizing ? 'Solving…' : result && !stale ? 'Re-optimise' : 'Optimise'}
          </button>
          <MiniPlayer />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => scrollToSurface('mathematics')} data-testid="hdr-math" aria-label="Mathematical investigation">
            <Icon name="sigma" size={14} /> <span className="hide-xl">Math</span>
          </button>
          <ExportMenu />
          <ThemeToggle compact />
          <ViewMenu />
        </div>
      </div>
      <nav className="cmd__nav" aria-label="Workspace surfaces">
        <ol>
          {SURFACES.map((s) => (
            <li key={s.id}>
              <a
                href={`#surface-${s.id}`}
                aria-current={active === s.id ? 'true' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  scrollToSurface(s.id);
                }}
                data-testid={`nav-${s.id}`}
              >
                <span className="mono">{s.key}</span> {s.label}
              </a>
            </li>
          ))}
        </ol>
        <div className="cmd__summary" aria-live="polite" data-testid="route-summary">
          {result && !stale ? (
            <>
              <span className="mono">{formatDistance(fleet ? fleet.makespan : result.route.totalDistance)}</span>
              <span className="faint">{fleet ? `longest of ${fleet.activeVehicles}` : `${result.route.steps.length} steps`}</span>
              <span className="mono num--repeat">+{formatDistance(result.route.repeatedDistance)}</span>
              <span className={`status-pill${result.algorithm.optimal ? ' is-ok' : ' is-bad'}`}>
                <Icon name={result.algorithm.optimal ? 'check' : 'cross'} size={11} /> {result.mode === 'directed' ? 'directed' : 'exact'}
              </span>
            </>
          ) : optimizing ? (
            <span className="faint">Solving…</span>
          ) : stale ? (
            <span className="faint">Out of date</span>
          ) : (
            <span className="faint">Not optimised</span>
          )}
        </div>
      </nav>
    </header>
  );
}
