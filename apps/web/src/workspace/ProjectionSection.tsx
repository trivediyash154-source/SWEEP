import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '../state/workspace';
import { useReducedMotion } from '../state/prefs';
import { formatDistance, formatNumber, formatPercent } from '../lib/format';
import { RouteProjection } from './RouteProjection';
import { routeClock } from './routeClock';
import { useRoute } from './useRouteData';
import type { RouteTrack } from '../lib/routeTrack';

/** One bar per vehicle: every traversal sized by its true length and coloured by kind; click to seek. */
function TraversalRibbon({ tracks, colors, makespan }: { tracks: RouteTrack[]; colors: Array<string | null>; makespan: number }) {
  const heads = useRef<Array<HTMLDivElement | null>>([]);
  useEffect(
    () =>
      routeClock.subscribe((s) => {
        const active = s > 0 || routeClock.playing;
        heads.current.forEach((el) => {
          if (el) el.style.left = `${makespan > 0 ? ((active ? Math.min(s, makespan) : 0) / makespan) * 100 : 0}%`;
        });
      }),
    [makespan],
  );
  return (
    <div className="ribbon" data-testid="traversal-ribbon">
      {tracks.map((t, ti) => (
        <div key={ti} className="ribbon__row">
          {tracks.length > 1 && (
            <span className="ribbon__label mono" style={{ color: colors[ti] ?? undefined }}>
              V{ti + 1}
            </span>
          )}
          <div
            className="ribbon__bar"
            style={{ width: `${makespan > 0 ? (t.total / makespan) * 100 : 100}%` }}
            role="slider"
            tabIndex={0}
            aria-label={tracks.length > 1 ? `Vehicle ${ti + 1} traversal order` : 'Traversal order'}
            aria-valuemin={0}
            aria-valuemax={Math.round(t.total)}
            aria-valuenow={0}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              routeClock.seek(((e.clientX - r.left) / r.width) * t.total);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') routeClock.seek(routeClock.s + t.total / 50);
              else if (e.key === 'ArrowLeft') routeClock.seek(routeClock.s - t.total / 50);
            }}
          >
            {t.steps.map((st, i) => (
              <span key={i} className={`ribbon__cell ribbon__cell--${st.kind}`} style={{ flexGrow: Math.max(st.weight, t.total * 0.0005) }} title={`#${i + 1} ${st.edgeId} · ${st.kind} · ${formatDistance(st.weight)}`} />
            ))}
          </div>
          <div className="ribbon__head" ref={(el) => {
            heads.current[ti] = el;
          }} aria-hidden="true" />
        </div>
      ))}
    </div>
  );
}

export function ProjectionSection() {
  const { graph, theme, tracks2d, colors, highlight, fresh, total } = useRoute();
  const reduced = useReducedMotion();
  const result = useWorkspace((s) => s.result);
  const fleet = useWorkspace((s) => s.fleet);
  const name = useWorkspace((s) => s.name);
  const [order, setOrder] = useState(true);
  const live = useRef<HTMLSpanElement>(null);
  useEffect(
    () =>
      routeClock.subscribe((s) => {
        if (live.current) live.current.textContent = total > 0 ? formatPercent((s > 0 || routeClock.playing ? Math.min(s, total) : 0) / total, 0) : '0%';
      }),
    [total],
  );
  const counts = useMemo(() => {
    if (!result || !fresh) return null;
    const steps = result.route.steps;
    const service = steps.filter((s) => s.kind === 'service').length;
    const repeat = steps.filter((s) => s.kind === 'repeat').length;
    const dead = steps.filter((s) => s.kind === 'deadhead').length;
    const closed = steps.length > 0 && steps[0]!.from === steps[steps.length - 1]!.to;
    // A street counts as repeated only if it has a traversal that serviced nothing new
    // (driving both directions of a two-way street in directed mode is service, not repetition).
    const repeatedStreets = new Set(steps.filter((s) => s.kind === 'repeat').map((s) => s.edgeId)).size;
    return { service, repeat, dead, closed, repeatedStreets };
  }, [result, fresh]);
  return (
    <section id="surface-projection" className="surface" aria-labelledby="proj-h" data-bloom-zone>
      <header className="surface__head">
        <p className="eyebrow">C · Live route projection</p>
        <h2 id="proj-h" className="dim-title">The traversal, in order.</h2>
        <p className="surface__lede muted">The same computed route as the city above, flattened to the street plan. The spectral trace follows the vehicle by true distance; numbered markers give the traversal order; dashed coral marks repeated streets and dashed gold marks optional streets driven only to reposition.</p>
      </header>
      <div className="proj-grid">
        <div className="proj-canvas">
          <RouteProjection
            graph={graph}
            tracks={fresh ? tracks2d : []}
            trackColors={colors}
            theme={theme}
            reduced={reduced}
            highlight={highlight.showRoute ? highlight : { ...highlight, showRoute: true }}
            depotId={result?.input.depotId ?? graph.depotId ?? null}
            showOrder={order}
            label={`Route projection for ${name}.`}
            testId="projection"
          />
          <label className="switch proj-order">
            <input type="checkbox" checked={order} onChange={(e) => setOrder(e.target.checked)} />
            <span className="switch__track" aria-hidden="true" />
            Traversal order
          </label>
        </div>
        <aside className="proj-readout" aria-label="Route figures">
          {result && fresh && counts ? (
            <dl className="readout-list">
              <div>
                <dt>Total distance</dt>
                <dd className="num num--lg" data-testid="proj-total">{formatDistance(fleet ? fleet.totalDistance : result.route.totalDistance)}</dd>
                {fleet && <dd className="faint small">across {fleet.activeVehicles} vehicles · single route {formatDistance(fleet.singleVehicleDistance)}</dd>}
              </div>
              <div>
                <dt>Repeated distance</dt>
                <dd className="num num--repeat">{formatDistance(result.route.repeatedDistance)}</dd>
                <dd className="faint small">{formatPercent(result.route.totalDistance > 0 ? result.route.repeatedDistance / result.route.totalDistance : 0)} of the route</dd>
              </div>
              <div>
                <dt>Traversals</dt>
                <dd className="num">{formatNumber(result.route.steps.length)}</dd>
                <dd className="faint small">
                  {counts.service} service · {counts.repeat} repeat · {counts.dead} deadhead
                </dd>
              </div>
              <div>
                <dt>Streets with repeated passes</dt>
                <dd className="num">{formatNumber(counts.repeatedStreets)}</dd>
              </div>
              <div>
                <dt>Progress</dt>
                <dd className="num" ref={live}>0%</dd>
              </div>
              <div>
                <dt>Closed loop</dt>
                <dd className={`status-pill${counts.closed ? ' is-ok' : ' is-bad'}`}>{counts.closed ? `Returns to ${result.input.depotId}` : 'Open'}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">Optimise the network to project its route.</p>
          )}
        </aside>
      </div>
      {fresh && tracks2d.length > 0 && (
        <div className="proj-ribbon">
          <div className="proj-ribbon__head">
            <h3 className="panel-title">Traversal ribbon</h3>
            <span className="legend-inline small">
              <i className="lg lg--service" /> service <i className="lg lg--repeat" /> repeat <i className="lg lg--deadhead" /> deadhead
            </span>
          </div>
          <TraversalRibbon tracks={tracks2d} colors={colors} makespan={total} />
        </div>
      )}
    </section>
  );
}
