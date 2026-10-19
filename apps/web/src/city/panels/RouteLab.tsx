import { useMemo, useState } from 'react';
import type { AlgorithmId, CityModel, ProfileId } from '@sweep/engine';
import { Icon } from '../../components/Icon';
import { useCity } from '../store';
import { ALL_ALGORITHMS, useRoute } from '../routeStore';
import { ALGO_COLOR } from '../overlays';
import { segmentLabel } from '../Inspector';
import { useScenarios } from '../scenario';
import { fmtDist, fmtTime } from '../format';
import { RouteReport } from './RouteReport';

const ALGO_LABEL: Record<AlgorithmId, string> = { dijkstra: 'Dijkstra', astar: 'A*', bidirectional: 'Bidirectional', alt: 'ALT', ch: 'Contraction Hierarchies' };
const PROFILE_LABEL: Record<ProfileId, string> = { car: 'Car', truck: 'Truck', bicycle: 'Bicycle', foot: 'Walking' };

export { fmtDist, fmtTime } from '../format';

/** Street names meeting at an intersection. */
export function nodeLabel(city: CityModel, n: number): string {
  const names = new Set<string>();
  for (let s = 0; s < city.segCount && names.size < 3; s++) if (city.segU[s] === n || city.segV[s] === n) names.add(segmentLabel(city, s));
  return [...names].slice(0, 2).join(' × ') || `Intersection ${city.nodeOsm[n]}`;
}

/** Street-name search: each match resolves to the intersection nearest the middle of that street. */
function useStreetIndex(city: CityModel) {
  return useMemo(() => {
    const degree = new Uint8Array(city.nodeCount);
    for (let s = 0; s < city.segCount; s++) {
      degree[city.segU[s]!] = Math.min(255, degree[city.segU[s]!]! + 1);
      degree[city.segV[s]!] = Math.min(255, degree[city.segV[s]!]! + 1);
    }
    const byName = new Map<string, { segs: number[]; len: number }>();
    for (let s = 0; s < city.segCount; s++) {
      const w = city.ways[city.segWay[s]!]!;
      const name = w.name ?? w.ref;
      if (!name) continue;
      const e = byName.get(name) ?? { segs: [], len: 0 };
      e.segs.push(s);
      e.len += city.segLen[s]!;
      byName.set(name, e);
    }
    return [...byName.entries()].map(([name, e]) => {
      // Middle intersection: the node of the street closest to the centroid of its segments' endpoints.
      let cx = 0;
      let cy = 0;
      const nodes = new Set<number>();
      for (const s of e.segs) {
        nodes.add(city.segU[s]!);
        nodes.add(city.segV[s]!);
      }
      for (const n of nodes) {
        cx += city.nodeX[n]!;
        cy += city.nodeY[n]!;
      }
      cx /= nodes.size;
      cy /= nodes.size;
      // Prefer a real junction (3+ streets), then a through node (2), never a dead end, when one exists.
      let best = -1;
      let bd = Infinity;
      let bestDeg = 0;
      for (const n of nodes) {
        const deg = Math.min(3, degree[n] ?? 0);
        const d = Math.hypot(city.nodeX[n]! - cx, city.nodeY[n]! - cy);
        if (deg > bestDeg || (deg === bestDeg && d < bd)) {
          bestDeg = deg;
          bd = d;
          best = n;
        }
      }
      return { name, node: best, len: e.len };
    });
  }, [city]);
}

function Endpoint({ which, city }: { which: 'origin' | 'destination'; city: CityModel }) {
  const node = useRoute((s) => (which === 'origin' ? s.origin : s.destination));
  const pickTarget = useCity((s) => s.pickTarget);
  const streets = useStreetIndex(city);
  const [q, setQ] = useState('');
  const matches = q.trim().length >= 2 ? streets.filter((s) => s.name.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => b.len - a.len).slice(0, 6) : [];
  const set = (n: number) => {
    const r = useRoute.getState();
    if (which === 'origin') r.setOrigin(n);
    else r.setDestination(n);
    setQ('');
    useCity.getState().setPickTarget(which === 'origin' && useRoute.getState().destination === null ? 'destination' : null);
  };
  const picking = pickTarget === which;
  return (
    <div className={`rl-end rl-end--${which}`} data-testid={`endpoint-${which}`}>
      <span className="rl-end__dot" aria-hidden="true" />
      <div className="rl-end__body">
        <div className="rl-end__row">
          <span className="rl-end__label">{which === 'origin' ? 'From' : 'To'}</span>
          <strong className="rl-end__value" data-testid={`${which}-label`}>
            {node !== null ? nodeLabel(city, node) : picking ? 'Click an intersection on the map' : 'Not set'}
          </strong>
          <button type="button" className={`btn btn--ghost btn--sm${picking ? ' is-on' : ''}`} aria-pressed={picking} onClick={() => useCity.getState().setPickTarget(picking ? null : which)} data-testid={`pick-${which}`}>
            <Icon name="focus" size={13} /> Pick
          </button>
        </div>
        <div className="rl-search">
          <input className="input input--sm" placeholder="Search a street…" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search a street for the ${which}`} data-testid={`search-${which}`} />
          {matches.length > 0 && (
            <ul className="rl-search__list" role="listbox">
              {matches.map((m) => (
                <li key={m.name}>
                  <button type="button" role="option" aria-selected={false} onClick={() => set(m.node)} data-testid="search-result">
                    {m.name} <span className="faint small">{fmtDist(m.len)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export function RouteLab() {
  const city = useCity((s) => s.city)!;
  const origin = useRoute((s) => s.origin);
  const destination = useRoute((s) => s.destination);
  const profile = useRoute((s) => s.profile);
  const objective = useRoute((s) => s.objective);
  const algorithms = useRoute((s) => s.algorithms);
  const running = useRoute((s) => s.running);
  const error = useRoute((s) => s.error);
  const runs = useRoute((s) => s.runs);
  const meta = useRoute((s) => s.meta);
  const active = useRoute((s) => s.active);
  const replaying = useRoute((s) => s.replaying);
  const reach = useRoute((s) => s.reach);
  const reachRunning = useRoute((s) => s.reachRunning);
  const scenarioName = useScenarios((s) => s.scenarios.find((x) => x.id === s.activeId)?.name ?? '');
  const r = useRoute.getState();
  const [showAssumptions, setShowAssumptions] = useState(false);
  const [report, setReport] = useState(false);

  const agree = useMemo(() => {
    if (!runs || runs.length < 2) return null;
    const found = runs.filter((x) => x.result.found);
    if (found.length !== runs.length) return found.length === 0 ? { ok: true, text: 'No route exists between these points for this profile.' } : { ok: false, text: 'Some algorithms found a route and others did not.' };
    const c0 = found[0]!.result.cost;
    const maxRel = Math.max(...found.map((x) => Math.abs(x.result.cost - c0) / Math.max(1e-9, c0)));
    return maxRel <= 1e-9 ? { ok: true, text: `All ${found.length} algorithms return the same optimal ${objective === 'time' ? 'travel time' : 'distance'} on the same graph.` } : { ok: false, text: `Costs differ by up to ${(maxRel * 100).toExponential(2)} %. This is a defect; please report it.` };
  }, [runs, objective]);

  const best = runs?.find((x) => x.result.algorithm === active)?.result ?? runs?.[0]?.result;
  return (
    <>
      <header>
        <p className="eyebrow">Route lab · point to point</p>
        <h2>Who reaches first, and why.</h2>
        <p className="muted small">
          Pick two intersections on the real Pune network. Every algorithm solves the same query on the same turn-aware graph with the same cost, and every returned route is checked independently. Scenario: <strong>{scenarioName}</strong>.
        </p>
      </header>

      <div className="rl-ends">
        <Endpoint which="origin" city={city} />
        <Endpoint which="destination" city={city} />
        <div className="rl-ends__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={r.swap} disabled={origin === null || destination === null} data-testid="swap-ends">
            ⇅ Swap
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={r.clear} data-testid="clear-route">
            Clear
          </button>
        </div>
      </div>

      <div className="rl-opts">
        <div className="segmented segmented--sm" role="group" aria-label="Travel profile">
          {(['car', 'truck', 'bicycle', 'foot'] as ProfileId[]).map((p) => (
            <button key={p} type="button" aria-pressed={profile === p} onClick={() => r.setProfile(p)} data-testid={`profile-${p}`}>
              {PROFILE_LABEL[p]}
            </button>
          ))}
        </div>
        <div className="segmented segmented--sm" role="group" aria-label="Objective">
          <button type="button" aria-pressed={objective === 'time'} onClick={() => r.setObjective('time')} data-testid="objective-time">
            Fastest
          </button>
          <button type="button" aria-pressed={objective === 'distance'} onClick={() => r.setObjective('distance')} data-testid="objective-distance">
            Shortest
          </button>
        </div>
      </div>

      <div className="rl-algos" role="group" aria-label="Algorithms to compare">
        {ALL_ALGORITHMS.map((a) => (
          <label key={a} className={`rl-algo${algorithms.includes(a) ? ' is-on' : ''}`} style={{ ['--algo' as string]: ALGO_COLOR[a] }}>
            <input type="checkbox" checked={algorithms.includes(a)} onChange={() => r.toggleAlgorithm(a)} data-testid={`algo-${a}`} />
            <i aria-hidden="true" /> {ALGO_LABEL[a]}
          </label>
        ))}
      </div>

      <button type="button" className="btn btn--primary btn--spectral" disabled={origin === null || destination === null || running} onClick={() => void r.run()} data-testid="run-route">
        {running ? <span className="spinner" aria-hidden="true" /> : <Icon name="route" size={15} />} {runs ? 'Run again' : 'Compare algorithms'}
      </button>
      {error && (
        <p className="notice notice--warn small" role="alert">
          {error}
        </p>
      )}

      {runs && best && (
        <section className="rl-results" aria-label="Comparison" data-testid="route-results">
          {best.found ? (
            <div className="rl-summary">
              <div>
                <span>Travel time</span>
                <strong data-testid="route-time">{fmtTime(best.timeS)}</strong>
              </div>
              <div>
                <span>Distance</span>
                <strong data-testid="route-distance">{fmtDist(best.distanceM)}</strong>
              </div>
              <div>
                <span>Turns</span>
                <strong>
                  {best.turns.left}L · {best.turns.right}R
                </strong>
              </div>
            </div>
          ) : (
            <p className="notice notice--warn small" data-testid="no-route">
              No permitted route for the {PROFILE_LABEL[profile].toLowerCase()} profile.{' '}
              {meta?.endpoints.originOut === 0
                ? 'The origin has no permitted departure (for example, the end of a one-way street, a private or closed road).'
                : meta?.endpoints.destinationIn === 0
                  ? 'The destination has no permitted arrival (one-way street pointing away, a private or closed road).'
                  : 'One-way streets, access restrictions or closures separate the two points.'}
            </p>
          )}
          {agree && (
            <p className={`rl-agree${agree.ok ? '' : ' is-bad'}`} data-testid="route-agreement">
              <Icon name={agree.ok ? 'check' : 'cross'} size={13} /> {agree.text}
            </p>
          )}
          <ul className="rl-rows" aria-label="Algorithms">
            {runs.map((x) => (
              <li key={x.result.algorithm} className={x.result.algorithm === active ? 'is-active' : ''} data-testid={`row-${x.result.algorithm}`}>
                <button type="button" className="rl-row" onClick={() => r.setActive(x.result.algorithm)} aria-pressed={x.result.algorithm === active} style={{ ['--algo' as string]: ALGO_COLOR[x.result.algorithm] }}>
                  <span className="rl-row__name">
                    <i aria-hidden="true" /> {ALGO_LABEL[x.result.algorithm]}
                  </span>
                  <span className="rl-row__stat" title="Directed arcs settled by the search">
                    <b data-testid={`settled-${x.result.algorithm}`}>{x.result.expanded.toLocaleString()}</b> settled
                  </span>
                  <span className="rl-row__stat" title="Median of 5 untraced runs in this browser (performance.now)">
                    <b>{x.result.runtimeMs < 0.1 ? `${(x.result.runtimeMs * 1000).toFixed(0)} µs` : `${x.result.runtimeMs.toFixed(2)} ms`}</b>
                  </span>
                  <span className={`status-pill${x.validation.ok ? ' is-ok' : ' is-bad'}`} title={x.validation.checks.map((c) => `${c.passed ? '✓' : '✗'} ${c.id}: ${c.detail}`).join('\n')} data-testid={`valid-${x.result.algorithm}`}>
                    {x.validation.ok ? '✓ valid' : '✗ invalid'}
                  </span>
                  <span className="rl-row__sub">
                    {x.result.edgesScanned.toLocaleString()} turn transitions scanned · preprocessing {x.result.preprocessing.required ? `${x.result.preprocessing.done ? 'built' : 'pending'} in ${x.result.preprocessing.ms.toFixed(0)} ms${x.result.preprocessing.detail ? ` (${x.result.preprocessing.detail})` : ''}` : 'none'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="rl-replay">
            <button type="button" className="btn btn--quiet btn--sm" onClick={replaying ? r.stopReplay : r.replay} data-testid="replay-search">
              <Icon name={replaying ? 'pause' : 'play'} size={13} /> {replaying ? 'Stop' : 'Replay search'}
            </button>
            <span className="faint small">The glow replays the recorded settle order of {active ? ALGO_LABEL[active] : 'the algorithm'}, then drives the route.</span>
          </div>
          {meta && (
            <p className="faint small">
              Graph: {meta.graphStats.allowedArcs.toLocaleString()} permitted directed arcs, {meta.graphStats.transitions.toLocaleString()} turn transitions{meta.graphBuildMs ? ` (built in ${meta.graphBuildMs.toFixed(0)} ms)` : ''}.
            </p>
          )}
          <button type="button" className="btn btn--quiet btn--sm" onClick={() => setReport(true)} data-testid="route-open-report">
            <Icon name="table" size={13} /> Printable report
          </button>
          {report && <RouteReport onClose={() => setReport(false)} />}
        </section>
      )}

      <section className="rl-reach" aria-label="Reachability">
        <div className="rl-reach__head">
          <h3>Reachable in 5 · 10 · 15 minutes</h3>
          <button type="button" className="btn btn--ghost btn--sm" disabled={origin === null || reachRunning} onClick={() => (reach ? r.clearReach() : void r.runReach())} data-testid="run-reach">
            {reachRunning ? <span className="spinner" aria-hidden="true" /> : null} {reach ? 'Hide' : 'Show from origin'}
          </button>
        </div>
        {reach && (
          <div className="rl-reach__bands" data-testid="reach-bands">
            {reach.levels.map((l, i) => (
              <div key={l.thresholdS} className={`rl-band rl-band--${i}`}>
                <i aria-hidden="true" />
                <strong>{l.thresholdS / 60} min</strong>
                <span data-testid={`reach-${l.thresholdS}`}>
                  {fmtDist(l.lengthM)} of street · {l.nodes.toLocaleString()} intersections
                </span>
              </div>
            ))}
            <p className="faint small">
              Earliest arrival along the real network for the {PROFILE_LABEL[profile].toLowerCase()} profile, including turn costs; streets are coloured where they are reached, not by a radius. Computed in {reach.runtimeMs.toFixed(1)} ms.
            </p>
          </div>
        )}
      </section>

      {meta && (
        <section className="rl-assume">
          <button type="button" className="btn btn--ghost btn--sm" aria-expanded={showAssumptions} onClick={() => setShowAssumptions(!showAssumptions)} data-testid="toggle-assumptions">
            {showAssumptions ? 'Hide' : 'Show'} the {PROFILE_LABEL[profile].toLowerCase()} profile assumptions
          </button>
          {showAssumptions && (
            <ul className="prov__list" data-testid="profile-assumptions">
              {meta.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
