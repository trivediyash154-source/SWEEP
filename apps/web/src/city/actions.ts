import type { PickResult } from './GeoCityScene';
import { useCity } from './store';
import { useRoute } from './routeStore';
import { useScenarios } from './scenario';
import { useCoverage } from './coverageStore';

/** Interprets a click on the city according to the current mode and pick target. */
export function handleCityPick(p: PickResult): void {
  const city = useCity.getState();
  const target = city.pickTarget;
  if (p.kind === 'node' && (target === 'origin' || target === 'destination')) {
    const r = useRoute.getState();
    if (target === 'origin') {
      r.setOrigin(p.node);
      city.setPickTarget(useRoute.getState().destination === null ? 'destination' : null);
    } else {
      r.setDestination(p.node);
      city.setPickTarget(null); // later clicks inspect the city until Pick is pressed again
    }
    city.select(p);
    return;
  }
  if (p.kind === 'node' && (target === 'depot' || target === 'dump')) {
    const cv = useCoverage.getState();
    if (target === 'depot') cv.setDepot(p.node);
    else cv.setDump(p.node);
    city.setPickTarget(null);
    city.select(p);
    return;
  }
  if (p.kind === 'node' && target === 'scenario-depot') {
    useScenarios.getState().setOps({ depot: p.node });
    city.setPickTarget(null);
    city.select(p);
    return;
  }
  if (target === 'zone-a' || target === 'zone-b') {
    useCoverage.getState().setCorner(target === 'zone-a' ? 'a' : 'b', p.x, p.y);
    city.setPickTarget(target === 'zone-a' ? 'zone-b' : null);
    return;
  }
  if (p.kind === 'segment' && target === 'close-road') {
    useScenarios.getState().toggleClosed(p.seg);
    city.select(p);
    rerunAll();
    return;
  }
  if (p.kind === 'segment' && target === 'make-oneway') {
    const sc = useScenarios.getState();
    const cur = sc.active().oneway.find(([g]) => g === p.seg)?.[1] ?? null;
    // Cycle: mapped → forward only → reverse only → two-way → mapped.
    const next = cur === null ? 'forward' : cur === 'forward' ? 'reverse' : cur === 'reverse' ? 'two-way' : null;
    sc.setOneway(p.seg, next);
    city.select(p);
    rerunAll();
    return;
  }
  city.select(p.kind === 'ground' ? null : p);
}

/** Recompute everything that depends on the scenario (routes, reachability). */
export function rerunAll(): void {
  const r = useRoute.getState();
  if (r.origin !== null && r.destination !== null) void r.run();
  if (r.reach && r.origin !== null) void r.runReach();
  const cv = useCoverage.getState();
  if (cv.result && cv.zone && cv.depot !== null) void cv.run();
}
