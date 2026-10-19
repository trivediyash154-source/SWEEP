import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Wordmark } from '../components/Wordmark';
import { ThemeToggle } from '../components/ThemeToggle';
import { Icon } from '../components/Icon';
import { usePrefs, useReducedMotion } from '../state/prefs';
import { lowPowerFor, startInLowPower, webglAvailable } from '../lib/webgl';
import { WebGLBoundary } from '../components/WebGLBoundary';
import { useCity, type CityMode } from './store';
import { FeatureDetails } from './Inspector';
import { ProvenanceDialog } from './Provenance';
import type { SceneOverlays } from './GeoCityScene';
import { useCityOverlays } from './overlays';
import { handleCityPick } from './actions';
import { useRoute } from './routeStore';
import { useScenarios } from './scenario';
import { useCoverage } from './coverageStore';
import { sampleScene } from './debug';
import { CityPanels } from './panels/CityPanels';
import { Timeline } from './panels/Timeline';
import '../styles/city.css';

const GeoCityScene = lazy(() => import('./GeoCityScene'));

const MODES: { id: CityMode; label: string; sub: string }[] = [
  { id: 'route', label: 'Route lab', sub: 'Point to point' },
  { id: 'coverage', label: 'Coverage & fleet', sub: 'Street service' },
  { id: 'scenarios', label: 'Scenarios', sub: 'What if' },
];

export default function CityWorkspace() {
  const theme = usePrefs((s) => s.theme);
  const reduced = useReducedMotion();
  const status = useCity((s) => s.status);
  const error = useCity((s) => s.error);
  const city = useCity((s) => s.city);
  const meshes = useCity((s) => s.meshes);
  const timings = useCity((s) => s.timings);
  const mode = useCity((s) => s.mode);
  const camera = useCity((s) => s.camera);
  const hover = useCity((s) => s.hover);
  const selection = useCity((s) => s.selection);
  const showEstimates = useCity((s) => s.showEstimates);
  const pickTarget = useCity((s) => s.pickTarget);
  const st = useCity.getState();
  const [prov, setProv] = useState(false);
  const [lowPower, setLowPower] = useState(startInLowPower);
  const debugRef = useRef<{ project: (x: number, y: number, h: number) => [number, number]; moving: () => boolean; appliedNonce: () => number } | null>(null);
  const webgl = webglAvailable();
  const overlays: SceneOverlays = useCityOverlays();

  useEffect(() => {
    document.title = 'SWEEP · City workspace';
    if (useCity.getState().status === 'idle') void useCity.getState().load();
    // Escape leaves any pick mode so the next click inspects the city.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && useCity.getState().pickTarget !== null) useCity.getState().setPickTarget(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    (window as unknown as { __sweepCity?: unknown }).__sweepCity = {
      project: (x: number, y: number, h: number) => debugRef.current?.project(x, y, h) ?? null,
      // True while a camera command is pending or the camera glides between views; screen positions are only
      // stable once it is false. A command reaches the scene after a delay, so "not animating" alone is not enough.
      cameraMoving: () => !debugRef.current || debugRef.current.moving() || debugRef.current.appliedNonce() !== useCity.getState().camera.nonce,
      state: () => useCity.getState(),
      route: () => useRoute.getState(),
      sample: (n?: number) => {
        const c = useCity.getState().city;
        return c && debugRef.current ? sampleScene(c, (x, y, h) => debugRef.current?.project(x, y, h) ?? null, n) : null;
      },
      scenarios: () => useScenarios.getState(),
      coverage: () => useCoverage.getState(),
    };
  }, []);

  const pickMode = useMemo(() => (pickTarget === 'origin' || pickTarget === 'destination' || pickTarget === 'depot' || pickTarget === 'dump' || pickTarget === 'scenario-depot' || pickTarget === 'extra-depot' ? 'node' : pickTarget === 'close-road' || pickTarget === 'make-oneway' ? 'segment' : pickTarget === 'zone' ? 'ground' : 'any'), [pickTarget]);

  return (
    <div className="cw" data-testid="city-workspace">
      <header className="cw-bar" data-testid="city-bar">
        <div className="cw-bar__id">
          <Wordmark size="sm" to="/" />
          <span className="cw-bar__sep" aria-hidden="true" />
          <div className="cw-bar__city">
            <strong data-testid="city-name">{city?.name ?? 'Loading city…'}</strong>
            {city && (
              <button type="button" className="cw-chip cw-chip--real" onClick={() => setProv(true)} data-testid="open-provenance" title="Where this data comes from">
                <Icon name="shield" size={12} /> Real OpenStreetMap data{city.provenance.tiles.missing.length ? ' · partial' : ''}
              </button>
            )}
          </div>
        </div>
        <nav className="cw-modes" aria-label="Workspace mode">
          {MODES.map((m) => (
            <button key={m.id} type="button" className={`cw-mode${mode === m.id ? ' is-on' : ''}`} aria-pressed={mode === m.id} onClick={() => st.setMode(m.id)} data-testid={`mode-${m.id}`}>
              <span>{m.label}</span>
              <small>{m.sub}</small>
            </button>
          ))}
        </nav>
        <div className="cw-bar__tools">
          <Link to="/lab" className="btn btn--ghost btn--sm" data-testid="open-lab" title="Small networks, the exact algorithm step by step">
            <Icon name="flask" size={14} /> Network lab
          </Link>
          <ThemeToggle compact />
        </div>
      </header>

      <main id="main" className="cw-stage" data-testid="city-stage">
        {status === 'error' && (
          <div className="cw-error notice notice--warn" role="alert">
            {error} The city dataset is bundled with SWEEP; check that <code>cities/index.json</code> is served.
          </div>
        )}
        {city && webgl ? (
          <WebGLBoundary fallback={<div className="cw-loading" role="status">The 3D view could not start on this device (WebGL is unavailable). The panels still work.</div>}>
          <Suspense fallback={<div className="cw-loading" role="status">Building the city…</div>}>
            <GeoCityScene
              city={city}
              meshes={meshes}
              theme={theme}
              reduced={reduced}
              lowPower={lowPower}
              onContext={(gl) => setLowPower(lowPowerFor(gl))}
              showEstimates={showEstimates}
              overlays={overlays}
              camera={camera}
              pickMode={pickMode}
              onPick={handleCityPick}
              onHover={(p) => st.setHover(p)}
              debugRef={debugRef}
              panelPx={420}
            />
          </Suspense>
          </WebGLBoundary>
        ) : city && !webgl ? (
          <div className="cw-error notice notice--warn" role="alert">
            This browser cannot create a WebGL context, so the 3D city cannot be drawn. Routing and planning still run; results appear in the panels.
          </div>
        ) : (
          status !== 'error' && <div className="cw-loading" role="status">Loading real Pune street and building data…</div>
        )}
        {city && !meshes && status === 'ready' && <div className="cw-loading cw-loading--soft" role="status">Extruding {city.buildingCount.toLocaleString()} buildings…</div>}

        <div className="cw-camera" role="toolbar" aria-label="Camera">
          <button type="button" className="tool" onClick={() => st.cameraCmd('overview')} aria-label="Overview of the whole area" data-tip="Overview" data-testid="cam-overview">
            <Icon name="fit" size={16} />
          </button>
          <button type="button" className="tool" onClick={() => st.cameraCmd('focus')} aria-label={`Focus on ${city?.focus?.label ?? 'the centre'}`} data-tip={city?.focus?.label ?? 'Focus'} data-testid="cam-focus">
            <Icon name="focus" size={16} />
          </button>
          <button type="button" className="tool" onClick={() => st.cameraCmd('street')} aria-label="Street-level view" data-tip="Street level" data-testid="cam-street">
            <Icon name="camera" size={16} />
          </button>
          <button type="button" className="tool" onClick={() => st.cameraCmd('top')} aria-label="Top-down view" data-tip="Top-down" data-testid="cam-top">
            <Icon name="top" size={16} />
          </button>
          <span className="cw-camera__sep" aria-hidden="true" />
          <button
            type="button"
            className={`tool${showEstimates ? ' is-on' : ''}`}
            aria-pressed={showEstimates}
            onClick={() => st.setShowEstimates(!showEstimates)}
            aria-label="Mark buildings whose height is estimated"
            data-tip="Show estimated heights"
            data-testid="toggle-estimates"
          >
            <Icon name="eye" size={16} />
          </button>
        </div>

        {city && <CityPanels />}

        {city && ((selection && selection.kind !== 'ground') || (hover && hover.kind !== 'ground')) && (
          <aside className="cw-inspect" aria-live="polite" data-testid="city-inspector">
            {selection && selection.kind !== 'ground' ? (
              <>
                <div className="cw-inspect__head">
                  <span className="cw-inspect__tag">Selected</span>
                  <button type="button" className="btn btn--ghost btn--icon btn--sm" onClick={() => st.select(null)} aria-label="Clear selection">
                    <Icon name="close" size={14} />
                  </button>
                </div>
                <FeatureDetails city={city} pick={selection} />
              </>
            ) : hover && hover.kind !== 'ground' ? (
              <FeatureDetails city={city} pick={hover} compact />
            ) : null}
          </aside>
        )}

        {city && (
          <div className="cw-legend" aria-label="Legend" data-testid="city-legend">
            <span>
              <i className="cwl cwl--road" /> Streets (OSM)
            </span>
            <span>
              <i className="cwl cwl--bld" /> Building footprints (OSM){showEstimates ? ' · tinted: estimated height' : ''}
            </span>
            <span className="cw-legend__attr" data-testid="city-attribution">
              © OpenStreetMap contributors · ODbL
            </span>
          </div>
        )}
        {city && <Timeline />}
      </main>
      {prov && city && <ProvenanceDialog city={city} onClose={() => setProv(false)} timings={timings} />}
    </div>
  );
}
