import { useEffect, useMemo, useRef } from 'react';
import { useWorkspace } from '../state/workspace';
import { useReducedMotion } from '../state/prefs';
import { formatDistance, formatNumber } from '../lib/format';
import { sampleTrack } from '../lib/routeTrack';
import { Icon } from '../components/Icon';
import { routeClock } from './routeClock';
import { useRoute } from './useRouteData';

const SPEEDS = [0.5, 1, 2, 4, 8];

/**
 * Route playback. The clock advances in TRUE route distance, so the vehicle
 * moves along the computed traversal at constant real speed and every readout
 * is an exact engine distance. Readouts are written to the DOM directly from
 * the clock (no React re-render per frame).
 */
export function PlaybackDeck() {
  const { tracks3d, total, fresh, graph, colors } = useRoute();
  const playing = useWorkspace((s) => s.playing);
  const speed = useWorkspace((s) => s.speed);
  const follow = useWorkspace((s) => s.follow);
  const activeVehicle = useWorkspace((s) => s.activeVehicle);
  const fleet = useWorkspace((s) => s.fleet);
  const reduced = useReducedMotion();
  const names = useMemo(() => new Map(graph.edges.map((e) => [e.id, e.name ?? e.id])), [graph]);
  const scrub = useRef<HTMLInputElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const travelled = useRef<HTMLSpanElement>(null);
  const remaining = useRef<HTMLSpanElement>(null);
  const stepEl = useRef<HTMLSpanElement>(null);
  const streetEl = useRef<HTMLSpanElement>(null);
  const kindEl = useRef<HTMLSpanElement>(null);
  const pctEl = useRef<HTMLSpanElement>(null);
  const vehEls = useRef<Array<HTMLSpanElement | null>>([]);

  const focusTrack = tracks3d[activeVehicle > 0 ? activeVehicle - 1 : 0] ?? null;
  const focusTotal = activeVehicle > 0 ? (focusTrack?.total ?? 0) : total;

  useEffect(() => {
    routeClock.speed = speed;
  }, [speed]);

  useEffect(() => routeClock.onEnd(() => useWorkspace.getState().setPlaying(false)), []);

  useEffect(() => {
    let last = 0;
    return routeClock.subscribe((s) => {
      const now = performance.now();
      if (routeClock.playing && now - last < 50) return;
      last = now;
      const active = s > 0 || routeClock.playing;
      const t = focusTrack;
      const d = Math.min(s, focusTotal);
      const frac = focusTotal > 0 ? (active ? d / focusTotal : 0) : 0;
      if (scrub.current) scrub.current.value = String(Math.round((total > 0 ? s / total : 0) * 1000));
      if (fill.current) fill.current.style.transform = `scaleX(${total > 0 ? (active ? s / total : 0) : 0})`;
      if (travelled.current) travelled.current.textContent = formatDistance(active ? d : 0);
      if (remaining.current) remaining.current.textContent = formatDistance(Math.max(0, focusTotal - (active ? d : 0)));
      if (pctEl.current) pctEl.current.textContent = `${Math.round(frac * 100)}%`;
      if (t && t.steps.length) {
        const smp = sampleTrack(t, active ? d : 0);
        const st = t.steps[smp.stepIndex]!;
        if (stepEl.current) stepEl.current.textContent = `${formatNumber(smp.stepIndex + 1)} / ${formatNumber(t.steps.length)}`;
        if (streetEl.current) streetEl.current.textContent = names.get(st.edgeId) ?? st.edgeId;
        if (kindEl.current) {
          kindEl.current.textContent = st.kind === 'repeat' ? `repeat · pass ${t.pass[smp.stepIndex]! + 1}` : st.kind;
          kindEl.current.className = `kind-tag kind-tag--${st.kind}`;
        }
      }
      tracks3d.forEach((tr, i) => {
        const el = vehEls.current[i];
        if (el) el.style.setProperty('--p', String(tr.total > 0 ? Math.min(1, (active ? s : 0) / tr.total) : 0));
      });
    });
  }, [focusTrack, focusTotal, total, tracks3d, names]);

  if (!fresh || total <= 0) return null;
  const toggle = () => {
    if (routeClock.playing) {
      routeClock.pause();
      useWorkspace.getState().setPlaying(false);
    } else {
      if (reduced) {
        routeClock.seek(total);
        return;
      }
      routeClock.play();
      useWorkspace.getState().setPlaying(true);
    }
  };
  return (
    <div className="deck" role="group" aria-label="Route playback" data-testid="playback">
      <div className="deck__controls">
        <button type="button" className="btn btn--primary btn--icon" onClick={toggle} aria-label={playing ? 'Pause vehicle' : 'Play vehicle'} data-testid="route-play">
          <Icon name={playing ? 'pause' : 'play'} size={16} />
        </button>
        <button
          type="button"
          className="btn btn--quiet btn--icon"
          onClick={() => {
            routeClock.pause();
            routeClock.seek(0);
            useWorkspace.getState().setPlaying(false);
            if (!reduced) {
              routeClock.play();
              useWorkspace.getState().setPlaying(true);
            }
          }}
          aria-label="Restart from the start"
          data-testid="route-restart"
        >
          <Icon name="restart" size={16} />
        </button>
        <div className="segmented segmented--sm deck__speed" role="group" aria-label="Playback speed">
          {SPEEDS.map((v) => (
            <button key={v} type="button" aria-pressed={speed === v} onClick={() => useWorkspace.getState().setSpeed(v)} data-testid={`speed-${v}`}>
              {v}×
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`btn btn--ghost btn--sm${follow ? ' is-on' : ''}`}
          aria-pressed={follow}
          onClick={() => useWorkspace.getState().cameraCommand(follow ? 'reset' : 'follow')}
          data-testid="camera-follow"
        >
          <Icon name="follow" size={14} /> {follow ? 'Following' : 'Follow'}
        </button>
      </div>
      <div className="deck__track">
        <div className="deck__bar" aria-hidden="true">
          <div ref={fill} className="deck__fill spectral-fill" />
        </div>
        <input
          ref={scrub}
          type="range"
          className="deck__scrub"
          min={0}
          max={1000}
          step={1}
          defaultValue={0}
          aria-label="Route progress"
          onChange={(e) => {
            routeClock.seek((Number(e.target.value) / 1000) * total);
          }}
          data-testid="route-scrub"
        />
      </div>
      <dl className="deck__readout" data-testid="playback-readout">
        <div>
          <dt>Step</dt>
          <dd className="mono" ref={stepEl}>—</dd>
        </div>
        <div className="deck__street">
          <dt>Street</dt>
          <dd>
            <span ref={kindEl} className="kind-tag kind-tag--service">service</span> <span ref={streetEl}>—</span>
          </dd>
        </div>
        <div>
          <dt>Travelled</dt>
          <dd className="mono" ref={travelled}>0 m</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd className="mono" ref={remaining}>—</dd>
        </div>
        <div>
          <dt>Progress</dt>
          <dd className="mono" ref={pctEl}>0%</dd>
        </div>
      </dl>
      {fleet && (
        <div className="deck__fleet" role="group" aria-label="Vehicles">
          <button type="button" className="chip-btn" aria-pressed={activeVehicle === 0} onClick={() => useWorkspace.getState().setActiveVehicle(0)} data-testid="vehicle-all">
            All {fleet.routes.length}
          </button>
          {fleet.routes.map((r, i) => (
            <button
              key={r.vehicle}
              type="button"
              className="chip-btn chip-btn--vehicle"
              aria-pressed={activeVehicle === i + 1}
              onClick={() => useWorkspace.getState().setActiveVehicle(i + 1)}
              style={{ ['--veh' as string]: colors[i] ?? undefined }}
              data-testid={`vehicle-${i + 1}`}
            >
              <span className="veh-dot" aria-hidden="true" />V{r.vehicle} <span className="mono faint">{formatDistance(r.distance)}</span>
              <span className="veh-progress" ref={(el) => {
                  vehEls.current[i] = el;
                }} aria-hidden="true" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
