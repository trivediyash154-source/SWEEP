import { useEffect, useRef } from 'react';
import type { OptimizationRecord } from '@sweep/engine';
import { EXPLAIN_STEPS, useWorkspace } from '../state/workspace';
import { formatDistance, formatNumber } from '../lib/format';
import { Icon } from '../components/Icon';
import { routeClock } from './routeClock';
import { useReducedMotion } from '../state/prefs';

function describe(step: number, r: OptimizationRecord): string {
  const k = r.oddVertexIds.length;
  const greedy = r.baselines.find((b) => b.id === 'greedy-pairing')?.total;
  switch (step) {
    case 0:
      return `${formatNumber(r.input.vertexCount)} intersections and ${formatNumber(r.input.edgeCount)} streets, of which ${formatNumber(r.input.requiredEdgeCount)} must be serviced (${formatDistance(r.route.requiredDistance)}). Every required street must be traversed at least once, and the route must return to its start.`;
    case 1:
      return k === 0
        ? 'Every intersection has an even number of required streets, so the network is already Eulerian: one closed walk can cover each street exactly once.'
        : `Count the required streets meeting at each intersection. ${formatNumber(k)} intersections have odd degree (highlighted). A closed walk enters and leaves each intersection in pairs, so odd intersections force repetition. Their number is always even, because the degrees sum to twice the number of streets.`;
    case 2:
      return k === 0
        ? 'No odd intersections, so no repositioning paths are needed.'
        : `Dijkstra's algorithm finds the shortest path between every pair of odd intersections over all streets. This defines a complete auxiliary graph on ${formatNumber(k)} vertices with ${formatNumber((k * (k - 1)) / 2)} weighted pairs${k > 24 ? ' (too many to draw here)' : ''}.`;
    case 3:
      return k === 0
        ? 'Nothing to pair.'
        : `Choose the pairing of odd intersections with the least total distance: ${formatDistance(r.matching.cost)} over ${r.matching.pairs.length} pair${r.matching.pairs.length === 1 ? '' : 's'}. Edmonds' blossom algorithm solves this exactly${r.matching.dualCertificateVerified ? ', and its LP-duality certificate proves no cheaper pairing exists' : ''}${r.matching.crossCheckCost !== null ? '; an independent subset-DP agrees' : ''}.${greedy !== undefined && greedy !== null ? ` Greedy pairing would add ${formatDistance(greedy - r.route.requiredDistance)}.` : ''}`;
    case 4:
      return `Duplicate each matched shortest path (${formatDistance(r.augmentation.addedDistance)} in total). Every intersection now has even degree${r.augmentation.allDegreesEven ? ' (checked)' : ''}, so the augmented network is Eulerian.`;
    case 5:
      return `Hierholzer's algorithm walks every edge of the augmented network exactly once: ${formatNumber(r.route.steps.length)} steps, ${formatDistance(r.route.totalDistance)} in total, starting and ending at ${r.input.depotId}.`;
    case 6: {
      const passed = r.checks.filter((c) => c.passed).length;
      return `${passed} of ${r.checks.length} independent checks passed: continuity, closure, coverage of every required street, distance consistency, even degrees and matching optimality. ${r.algorithm.optimal ? 'The route is optimal for this network.' : ''}`;
    }
    default:
      return '';
  }
}

export function ExplainBar() {
  const ws = useWorkspace();
  const reduced = useReducedMotion();
  const { result, explainStep, playing, speed } = ws;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!playing || !result) return;
    if (explainStep >= EXPLAIN_STEPS.length - 1) {
      ws.setPlaying(false);
      return;
    }
    if (explainStep === 5 && !reduced) {
      return routeClock.onEnd(() => {
        timer.current = setTimeout(() => ws.setExplainStep(6), 600 / speed);
      });
    }
    timer.current = setTimeout(() => ws.setExplainStep(explainStep + 1), 3400 / speed);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line
  }, [playing, explainStep, result, speed, reduced]);

  useEffect(() => {
    routeClock.speed = speed;
  }, [speed]);

  if (!result) {
    return (
      <div className="explain-bar" data-testid="explain-bar">
        <p className="muted">Optimise the route first; the explanation is generated from the actual computation.</p>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => void ws.runOptimize()}>
          Optimize route
        </button>
      </div>
    );
  }

  return (
    <div className="explain-bar" data-testid="explain-bar">
      <div className="explain-head">
        <ol className="explain-steps" aria-label="Algorithm steps">
          {EXPLAIN_STEPS.map((label, i) => (
            <li key={label}>
              <button
                type="button"
                aria-current={i === explainStep ? 'step' : undefined}
                aria-label={`Step ${i + 1}: ${label}`}
                data-tip={label}
                className={i < explainStep ? 'is-done' : ''}
                onClick={() => ws.setExplainStep(i)}
              >
                <span className="mono">{i + 1}</span>
              </button>
            </li>
          ))}
        </ol>
        <h3 className="explain-title">
          <span className="faint mono">{String(explainStep + 1).padStart(2, '0')} / 07</span> {EXPLAIN_STEPS[explainStep]}
        </h3>
        <div className="explain-controls" role="group" aria-label="Playback">
          <button type="button" className="btn btn--quiet btn--icon btn--sm" onClick={() => { ws.setPlaying(false); ws.setExplainStep(0); }} aria-label="Restart">
            <Icon name="restart" size={15} />
          </button>
          <button type="button" className="btn btn--quiet btn--icon btn--sm" onClick={() => ws.setExplainStep(explainStep - 1)} disabled={explainStep === 0} aria-label="Previous step">
            <Icon name="prev" size={15} />
          </button>
          <button type="button" className="btn btn--primary btn--icon btn--sm" onClick={() => ws.setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'} data-testid="explain-play">
            <Icon name={playing ? 'pause' : 'play'} size={15} />
          </button>
          <button type="button" className="btn btn--quiet btn--icon btn--sm" onClick={() => ws.setExplainStep(explainStep + 1)} disabled={explainStep === EXPLAIN_STEPS.length - 1} aria-label="Next step" data-testid="explain-next">
            <Icon name="next" size={15} />
          </button>
          <SpeedPicker />
        </div>
      </div>
      <p className="explain-text" aria-live="polite" data-testid="explain-text">
        {describe(explainStep, result)}
      </p>
    </div>
  );
}

export function SpeedPicker() {
  const speed = useWorkspace((s) => s.speed);
  const setSpeed = useWorkspace((s) => s.setSpeed);
  return (
    <div className="segmented segmented--sm" role="group" aria-label="Playback speed">
      {[0.5, 1, 2, 4].map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={speed === s}
          onClick={() => {
            setSpeed(s);
            routeClock.speed = s;
          }}
        >
          {s}×
        </button>
      ))}
    </div>
  );
}
