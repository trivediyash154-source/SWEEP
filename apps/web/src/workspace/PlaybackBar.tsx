import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '../state/workspace';
import { buildRouteGeometry, sampleRoute } from '../lib/geometry';
import { formatDistance } from '../lib/format';
import { Icon } from '../components/Icon';
import { routeClock } from './routeClock';
import { SpeedPicker } from './ExplainBar';

export function PlaybackBar() {
  const { result, resultGraph, stale, speed } = useWorkspace();
  const geo = useMemo(() => (result && resultGraph ? buildRouteGeometry(resultGraph, result.route.steps) : null), [result, resultGraph]);
  const [readout, setReadout] = useState({ s: 0, distance: 0, step: 0 });
  const [playing, setPlaying] = useState(routeClock.playing);
  const names = useMemo(() => new Map((resultGraph?.edges ?? []).map((e) => [e.id, e.name ?? e.id])), [resultGraph]);
  const lastPaint = useRef(0);

  useEffect(() => {
    if (!geo) return;
    routeClock.setTotal(geo.totalDrawn);
    routeClock.speed = speed;
    const unsub = routeClock.subscribe((s) => {
      const now = performance.now();
      if (now - lastPaint.current < 60 && routeClock.playing) return;
      lastPaint.current = now;
      const sm = sampleRoute(geo, s);
      setReadout({ s, distance: sm.distance, step: sm.stepIndex });
      setPlaying(routeClock.playing);
    });
    const unEnd = routeClock.onEnd(() => setPlaying(false));
    return () => {
      unsub();
      unEnd();
      routeClock.pause();
    };
  }, [geo, speed]);

  if (!result || !geo || stale) return null;
  const step = result.route.steps[readout.step];
  const frac = geo.totalDrawn > 0 ? readout.s / geo.totalDrawn : 0;
  const done = readout.s >= geo.totalDrawn && geo.totalDrawn > 0;

  return (
    <div className="playback" role="group" aria-label="Route playback" data-testid="playback">
      <button
        type="button"
        className="btn btn--primary btn--icon btn--sm"
        onClick={() => {
          if (routeClock.playing) routeClock.pause();
          else routeClock.play();
          setPlaying(routeClock.playing);
        }}
        aria-label={playing ? 'Pause route' : 'Play route'}
        data-testid="route-play"
      >
        <Icon name={playing ? 'pause' : 'play'} size={15} />
      </button>
      <button type="button" className="btn btn--quiet btn--icon btn--sm" onClick={() => { routeClock.reset(); setPlaying(false); }} aria-label="Restart route">
        <Icon name="restart" size={15} />
      </button>
      <input
        type="range"
        className="playback__scrub"
        min={0}
        max={1000}
        step={1}
        value={Math.round(frac * 1000)}
        aria-label="Route progress"
        aria-valuetext={`${formatDistance(readout.distance)} of ${formatDistance(result.route.totalDistance)}`}
        onChange={(e) => routeClock.seek((Number(e.target.value) / 1000) * geo.totalDrawn)}
        style={{ ['--p' as string]: `${frac * 100}%` }}
      />
      <span className="playback__readout mono" data-testid="playback-readout">
        {formatDistance(done ? result.route.totalDistance : readout.distance)} <span className="faint">/ {formatDistance(result.route.totalDistance)}</span>
      </span>
      <span className="playback__street small">
        {step ? (
          <>
            <span className={`kind-tag kind-tag--${step.kind}`}>{step.kind}</span> {names.get(step.edgeId)} <span className="faint mono">
              {readout.step + 1}/{result.route.steps.length}
            </span>
          </>
        ) : null}
      </span>
      <SpeedPicker />
    </div>
  );
}
