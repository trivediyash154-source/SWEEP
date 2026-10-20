import { useEffect, useMemo } from 'react';
import type { CityModel } from '@sweep/engine';
import { Icon } from '../../components/Icon';
import { useCity } from '../store';
import { effectiveInputs, useCoverage } from '../coverageStore';
import { BASELINE, useScenarios } from '../scenario';
import { arcPoints } from '../overlays';
import { buildSchedule, clockLabel, positionAt } from '../timeline';
import { SHIFT_SECONDS_PER_SECOND, useShift, vehiclePoses } from '../shift';
import { VEHICLE_COLORS } from './CoveragePanel';
import { fmtTime } from './RouteLab';

/** Point and heading at a fraction of an arc's polyline. */
function pointOnArc(city: CityModel, arc: number, frac: number): { x: number; y: number; heading: number } {
  const p = arcPoints(city, arc);
  const n = p.length / 2;
  let total = 0;
  for (let i = 1; i < n; i++) total += Math.hypot(p[2 * i]! - p[2 * i - 2]!, p[2 * i + 1]! - p[2 * i - 1]!);
  let target = frac * total;
  for (let i = 1; i < n; i++) {
    const dx = p[2 * i]! - p[2 * i - 2]!;
    const dy = p[2 * i + 1]! - p[2 * i - 1]!;
    const l = Math.hypot(dx, dy);
    if (target <= l || i === n - 1) {
      const f = l > 0 ? Math.min(1, target / l) : 0;
      return { x: p[2 * i - 2]! + dx * f, y: p[2 * i - 1]! + dy * f, heading: Math.atan2(dy, dx) };
    }
    target -= l;
  }
  return { x: p[0]!, y: p[1]!, heading: 0 };
}

const streetName = (city: CityModel, arc: number) => {
  const w = city.ways[city.segWay[arc >> 1]!]!;
  return w.name ?? w.ref ?? `unnamed ${w.highway.replace(/_/g, ' ')}`;
};

/**
 * Operational shift timeline for a coverage plan: a deterministic clock derived
 * from the planned steps (length ÷ speed, plus unloading time). Scrub to any
 * moment or play at one shift-minute per second.
 */
export function Timeline() {
  const city = useCity((s) => s.city);
  const mode = useCity((s) => s.mode);
  const result = useCoverage((s) => s.result);
  const depot = useCoverage((s) => s.depot);
  const baseFleet = useCoverage((s) => s.fleet);
  const costs = useCoverage((s) => s.costs);
  const scenario = useScenarios((s) => s.scenarios.find((x) => x.id === s.activeId)) ?? BASELINE;
  // Speeds and the shift limit the plan was made with (a scenario may override the shift limit).
  const fleet = useMemo(() => effectiveInputs({ depot, fleet: baseFleet, costs }, scenario).fleet, [depot, baseFleet, costs, scenario]);
  const { t, playing, startOfDay } = useShift();

  const schedules = useMemo(() => (result ? result.routes.map((r) => buildSchedule(r, fleet)) : []), [result, fleet]);
  const makespan = schedules.reduce((m, s) => Math.max(m, s.totalSeconds), 0);
  const show = !!city && mode === 'coverage' && !!result && makespan > 0;

  // Reset the clock for a new plan.
  useEffect(() => {
    useShift.getState().setT(0);
    useShift.getState().setPlaying(false);
  }, [result]);

  // Real-time playback at a fixed rate.
  useEffect(() => {
    if (!playing || !show) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const st = useShift.getState();
      const next = st.t + ((now - last) / 1000) * SHIFT_SECONDS_PER_SECOND;
      last = now;
      if (next >= makespan) {
        st.setT(makespan);
        st.setPlaying(false);
        return;
      }
      st.setT(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, show, makespan]);

  const positions = useMemo(() => (result ? result.routes.map((r, i) => positionAt(schedules[i]!, r.kinds, r.lengths, t)) : []), [result, schedules, t]);

  // Vehicle markers on the map.
  useEffect(() => {
    if (!show || !city || !result) {
      vehiclePoses.current = [];
      return;
    }
    vehiclePoses.current = result.routes.flatMap((r, i) => {
      const p = positions[i]!;
      if (p.step < 0) return [];
      const pt = pointOnArc(city, r.arcs[p.step]!, p.finished ? 1 : p.frac);
      return [{ x: pt.x, y: pt.y, heading: pt.heading, color: VEHICLE_COLORS[i % VEHICLE_COLORS.length]! }];
    });
  }, [show, city, result, positions]);
  useEffect(() => () => void (vehiclePoses.current = []), []);

  if (!show || !result || !city) return null;
  const shift = fleet.shiftSeconds;
  return (
    <section className="tl" aria-label="Shift timeline" data-testid="shift-timeline">
      <div className="tl__bar">
        <button type="button" className="btn btn--quiet btn--icon btn--sm" aria-label={playing ? 'Pause' : 'Play'} onClick={() => useShift.getState().setPlaying(!playing)} data-testid="tl-play">
          <Icon name={playing ? 'pause' : 'play'} size={14} />
        </button>
        <label className="tl__start">
          <span className="faint small">Shift start</span>
          <input
            className="input input--sm"
            type="time"
            value={clockLabel(startOfDay)}
            onChange={(e) => {
              const [h, m] = e.target.value.split(':').map(Number);
              if (Number.isFinite(h) && Number.isFinite(m)) useShift.getState().setStartOfDay(h! * 3600 + m! * 60);
            }}
            data-testid="tl-start"
          />
        </label>
        <strong className="tl__clock" data-testid="tl-clock">
          {clockLabel(startOfDay + t)}
        </strong>
        <input
          className="tl__scrub"
          type="range"
          min={0}
          max={Math.ceil(makespan)}
          step={1}
          value={Math.min(Math.round(t), Math.ceil(makespan))}
          onChange={(e) => {
            useShift.getState().setPlaying(false);
            useShift.getState().setT(Number(e.target.value));
          }}
          aria-label="Shift time"
          aria-valuetext={`${clockLabel(startOfDay + t)}, ${fmtTime(t)} into the shift`}
          data-testid="tl-scrub"
        />
        <span className="faint small">ends {clockLabel(startOfDay + makespan)}</span>
      </div>
      <ul className="tl__vehicles">
        {result.routes.map((r, i) => {
          const p = positions[i]!;
          const over = shift !== null && schedules[i]!.totalSeconds > shift;
          return (
            <li key={r.vehicle} className={over ? 'is-over' : ''} data-testid={`tl-vehicle-${i}`}>
              <i className="cv-swatch" style={{ background: VEHICLE_COLORS[i % VEHICLE_COLORS.length] }} aria-hidden="true" />
              <strong>{i + 1}</strong>
              <span className="tl__street">{p.finished ? 'back at depot' : p.unloading ? 'unloading' : streetName(city, r.arcs[p.step]!)}</span>
              <span data-testid={`tl-progress-${i}`}>{Math.floor(p.progress * 100)} %</span>
              <span className="faint">done {clockLabel(startOfDay + schedules[i]!.totalSeconds)}</span>
              {over && <span className="sc-tag sc-tag--closed">over shift by {fmtTime(schedules[i]!.totalSeconds - shift!)}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
