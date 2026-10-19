import type { CheckResult, Edge, Graph, RouteStep, TwoWayService } from './types.js';
import { toScaled, fromScaled } from './units.js';

/**
 * Independent route verification. It deliberately does not reuse solver
 * internals: it re-derives every invariant from the raw graph and the ordered
 * list of route steps.
 */
export function verifyRoute(graph: Graph, steps: RouteStep[], opts: { depotId: string; expectedTotal?: number }): { ok: boolean; checks: CheckResult[] } {
  const edges = new Map(graph.edges.map((e) => [e.id, e]));
  const checks: CheckResult[] = [];

  // 1. Each step uses an existing edge in a valid orientation, consecutively.
  let continuity = steps.length > 0 && steps[0]!.from === opts.depotId;
  let continuityDetail = continuity ? `Starts at ${opts.depotId}.` : `Route does not start at ${opts.depotId}.`;
  for (let i = 0; i < steps.length && continuity; i++) {
    const s = steps[i]!;
    const e = edges.get(s.edgeId);
    const orientationOk = !!e && ((s.from === e.u && s.to === e.v) || (s.from === e.v && s.to === e.u));
    const joined = i === 0 || steps[i - 1]!.to === s.from;
    if (!orientationOk || !joined) {
      continuity = false;
      continuityDetail = `Step ${i + 1} (${s.edgeId}: ${s.from}→${s.to}) is ${!orientationOk ? 'not a valid traversal of that street' : 'not connected to the previous step'}.`;
    }
  }
  if (continuity) continuityDetail = `All ${steps.length} steps are valid street traversals and each begins where the previous one ended.`;
  checks.push({ id: 'continuity', label: 'Route is continuous', passed: continuity, detail: continuityDetail });

  // 2. Closed walk.
  const closed = steps.length > 0 && steps[steps.length - 1]!.to === opts.depotId;
  checks.push({ id: 'closed', label: 'Route returns to its start', passed: closed, detail: closed ? `Begins and ends at ${opts.depotId}.` : 'The final step does not end at the start vertex.' });

  // 3. Coverage of required edges.
  const count = new Map<string, number>();
  for (const s of steps) count.set(s.edgeId, (count.get(s.edgeId) ?? 0) + 1);
  const missing = graph.edges.filter((e) => e.required && !count.get(e.id)).map((e) => e.id);
  const requiredCount = graph.edges.filter((e) => e.required).length;
  checks.push({
    id: 'coverage',
    label: 'Every required street is serviced',
    passed: missing.length === 0,
    detail: missing.length === 0 ? `${requiredCount} of ${requiredCount} required streets covered.` : `Missing: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`,
  });

  // 4. Weight and cumulative-distance consistency (exact, in scaled integers).
  let running = 0;
  let weightsOk = true;
  let weightDetail = '';
  for (const s of steps) {
    const e = edges.get(s.edgeId);
    if (!e) {
      weightsOk = false;
      weightDetail = `Unknown edge ${s.edgeId}.`;
      break;
    }
    running += toScaled(e.weight);
    if (toScaled(s.weight) !== toScaled(e.weight) || toScaled(s.cumulative) !== running) {
      weightsOk = false;
      weightDetail = `Step ${s.index + 1} reports inconsistent distance.`;
      break;
    }
  }
  if (weightsOk && opts.expectedTotal !== undefined && toScaled(opts.expectedTotal) !== running) {
    weightsOk = false;
    weightDetail = `Sum of steps ${fromScaled(running)} differs from reported total ${opts.expectedTotal}.`;
  }
  if (weightsOk) weightDetail = `Sum of the ${steps.length} traversed street lengths = ${fromScaled(running)}.`;
  checks.push({ id: 'weights', label: 'Distances are consistent', passed: weightsOk, detail: weightDetail });

  // 5. Traversal classification.
  const seen = new Set<string>();
  let kindsOk = true;
  for (const s of steps) {
    const e = edges.get(s.edgeId);
    const expected = !e?.required ? 'deadhead' : seen.has(s.edgeId) ? 'repeat' : 'service';
    if (s.kind !== expected) kindsOk = false;
    seen.add(s.edgeId);
  }
  checks.push({
    id: 'classification',
    label: 'Service, repeat and deadhead labels are correct',
    passed: kindsOk,
    detail: kindsOk ? 'First pass over a required street = service; later passes = repeat; optional streets = deadhead.' : 'A step is mislabelled.',
  });

  return { ok: checks.every((c) => c.passed), checks };
}

/**
 * Independent verification of a route on a network with one-way streets. Like
 * verifyRoute it re-derives every invariant from the raw graph: permitted
 * directions, directional costs, service obligations and classification.
 */
export function verifyDirectedRoute(
  graph: Graph,
  steps: RouteStep[],
  opts: { depotId: string; twoWay: TwoWayService; expectedTotal?: number },
): { ok: boolean; checks: CheckResult[] } {
  const edges = new Map(graph.edges.map((e) => [e.id, e]));
  const oneway = (e: Edge): boolean => e.oneway === true || e.directed === true;
  const checks: CheckResult[] = [];

  // 1. Continuity and permitted directions.
  let continuity = steps.length > 0 && steps[0]!.from === opts.depotId;
  let continuityDetail = continuity ? '' : `Route does not start at ${opts.depotId}.`;
  let wrongWay = 0;
  for (let i = 0; i < steps.length && continuity; i++) {
    const s = steps[i]!;
    const e = edges.get(s.edgeId);
    const forward = !!e && s.from === e.u && s.to === e.v;
    const backward = !!e && s.from === e.v && s.to === e.u;
    if (!forward && !backward) {
      continuity = false;
      continuityDetail = `Step ${i + 1} (${s.edgeId}: ${s.from}→${s.to}) is not a traversal of that street.`;
    } else if (i > 0 && steps[i - 1]!.to !== s.from) {
      continuity = false;
      continuityDetail = `Step ${i + 1} does not begin where step ${i} ended.`;
    }
    if (e && oneway(e) && !forward) wrongWay++;
  }
  if (continuity) continuityDetail = `All ${steps.length} steps are traversals of existing streets and each begins where the previous one ended.`;
  checks.push({ id: 'continuity', label: 'Route is continuous', passed: continuity, detail: continuityDetail });
  const onewayCount = graph.edges.filter(oneway).length;
  checks.push({
    id: 'direction',
    label: 'One-way restrictions respected',
    passed: wrongWay === 0,
    detail: wrongWay === 0 ? `No traversal goes against any of the ${onewayCount} one-way street(s).` : `${wrongWay} traversal(s) go against a one-way street.`,
  });

  // 2. Closed walk.
  const closed = steps.length > 0 && steps[steps.length - 1]!.to === opts.depotId;
  checks.push({ id: 'closed', label: 'Route returns to its start', passed: closed, detail: closed ? `Begins and ends at ${opts.depotId}.` : 'The final step does not end at the start vertex.' });

  // 3. Service obligations.
  const key = (e: Edge, forward: boolean): string => (opts.twoWay === 'either' || oneway(e) || e.u === e.v ? e.id : `${e.id}:${forward ? 'f' : 'b'}`);
  const needed = new Set<string>();
  for (const e of graph.edges) {
    if (!e.required) continue;
    if (opts.twoWay === 'both' && !oneway(e) && e.u !== e.v) {
      needed.add(`${e.id}:f`);
      needed.add(`${e.id}:b`);
    } else needed.add(e.id);
  }
  const done = new Set<string>();
  let kindsOk = true;
  for (const s of steps) {
    const e = edges.get(s.edgeId);
    if (!e) continue;
    const k = key(e, s.from === e.u && s.to === e.v);
    const expected = !e.required ? 'deadhead' : needed.has(k) && !done.has(k) ? 'service' : 'repeat';
    if (s.kind !== expected) kindsOk = false;
    if (e.required) done.add(k);
  }
  const missing = [...needed].filter((k) => !done.has(k));
  checks.push({
    id: 'coverage',
    label: opts.twoWay === 'both' ? 'Every required street serviced in every required direction' : 'Every required street is serviced',
    passed: missing.length === 0,
    detail: missing.length === 0 ? `${needed.size} of ${needed.size} service obligations fulfilled.` : `Missing: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`,
  });

  // 4. Directional costs and cumulative distance (exact, scaled integers).
  let running = 0;
  let weightsOk = true;
  let weightDetail = '';
  for (const s of steps) {
    const e = edges.get(s.edgeId);
    if (!e) {
      weightsOk = false;
      weightDetail = `Unknown edge ${s.edgeId}.`;
      break;
    }
    const forward = s.from === e.u && s.to === e.v;
    const cost = toScaled(forward || e.u === e.v ? e.weight : (e.reverseWeight ?? e.weight));
    running += cost;
    if (toScaled(s.weight) !== cost || toScaled(s.cumulative) !== running) {
      weightsOk = false;
      weightDetail = `Step ${s.index + 1} reports an inconsistent distance.`;
      break;
    }
  }
  if (weightsOk && opts.expectedTotal !== undefined && toScaled(opts.expectedTotal) !== running) {
    weightsOk = false;
    weightDetail = `Sum of steps ${fromScaled(running)} differs from reported total ${opts.expectedTotal}.`;
  }
  if (weightsOk) weightDetail = `Sum of the ${steps.length} directional traversal costs = ${fromScaled(running)}.`;
  checks.push({ id: 'weights', label: 'Distances are consistent', passed: weightsOk, detail: weightDetail });

  checks.push({
    id: 'classification',
    label: 'Service, repeat and deadhead labels are correct',
    passed: kindsOk,
    detail: kindsOk ? 'First fulfilment of an obligation = service; other passes over required streets = repeat; optional streets = deadhead.' : 'A step is mislabelled.',
  });
  return { ok: checks.every((c) => c.passed), checks };
}

/**
 * Independent verification of a multi-vehicle plan: every route is a legal
 * closed walk from the depot with consistent distances, and together the
 * routes fulfil every service obligation. Service labels are checked
 * fleet-wide in vehicle order (the first fulfilment of an obligation is the service).
 */
export function verifyFleet(
  graph: Graph,
  routes: { steps: RouteStep[]; distance: number }[],
  opts: { depotId: string; directed: boolean; twoWay: TwoWayService },
): { ok: boolean; checks: CheckResult[]; perVehicle: CheckResult[][]; coverage: { obligations: number; covered: number; missingEdgeIds: string[]; sharedEdgeIds: string[] } } {
  const edges = new Map(graph.edges.map((e) => [e.id, e]));
  const oneway = (e: Edge): boolean => e.oneway === true || e.directed === true;
  const perDirection = (e: Edge): boolean => opts.directed && opts.twoWay === 'both' && !oneway(e) && e.u !== e.v;
  const needed = new Set<string>();
  for (const e of graph.edges) {
    if (!e.required) continue;
    if (perDirection(e)) {
      needed.add(`${e.id}:f`);
      needed.add(`${e.id}:b`);
    } else needed.add(e.id);
  }
  const done = new Set<string>();
  const usedBy = new Map<string, Set<number>>();
  let kindsOk = true;
  const perVehicle: CheckResult[][] = routes.map((r, vi) => {
    let legal = r.steps.length > 0 && r.steps[0]!.from === opts.depotId;
    let detail = legal ? '' : `Route ${vi + 1} does not start at the depot.`;
    let running = 0;
    let weightsOk = true;
    for (let i = 0; i < r.steps.length; i++) {
      const s = r.steps[i]!;
      const e = edges.get(s.edgeId);
      const forward = !!e && s.from === e.u && s.to === e.v;
      const backward = !!e && s.from === e.v && s.to === e.u;
      if (legal && (!e || (!forward && !backward) || (opts.directed && oneway(e) && !forward) || (i > 0 && r.steps[i - 1]!.to !== s.from))) {
        legal = false;
        detail = `Step ${i + 1} (${s.edgeId}: ${s.from}→${s.to}) is not a legal continuation.`;
      }
      if (!e) continue;
      const cost = toScaled(forward || e.u === e.v || !opts.directed ? e.weight : (e.reverseWeight ?? e.weight));
      running += cost;
      if (toScaled(s.weight) !== cost || toScaled(s.cumulative) !== running) weightsOk = false;
      const key = perDirection(e) ? `${e.id}:${forward ? 'f' : 'b'}` : e.id;
      const expected = !e.required ? 'deadhead' : needed.has(key) && !done.has(key) ? 'service' : 'repeat';
      if (s.kind !== expected) kindsOk = false;
      if (e.required) done.add(key);
      if (!usedBy.has(e.id)) usedBy.set(e.id, new Set());
      usedBy.get(e.id)!.add(vi);
    }
    if (toScaled(r.distance) !== running) weightsOk = false;
    if (legal) detail = `${r.steps.length} legal steps from the depot.`;
    const closed = r.steps.length > 0 && r.steps[r.steps.length - 1]!.to === opts.depotId;
    return [
      { id: 'continuity', label: 'Route is continuous and legal', passed: legal, detail },
      { id: 'closed', label: 'Route returns to the depot', passed: closed, detail: closed ? `Ends at ${opts.depotId}.` : 'Does not end at the depot.' },
      { id: 'weights', label: 'Distances are consistent', passed: weightsOk, detail: weightsOk ? `Length ${fromScaled(running)}.` : 'A step or the route total is inconsistent.' },
    ];
  });
  const missing = [...needed].filter((k) => !done.has(k));
  const missingEdgeIds = [...new Set(missing.map((k) => k.split(':')[0]!))];
  const sharedEdgeIds = [...usedBy.entries()].filter(([id, s]) => s.size > 1 && edges.get(id)?.required).map(([id]) => id);
  const checks: CheckResult[] = [
    {
      id: 'routes-valid',
      label: 'Every vehicle route is a legal closed walk from the depot',
      passed: perVehicle.every((c) => c.every((x) => x.passed)),
      detail: `${routes.length} route(s) checked step by step.`,
    },
    {
      id: 'coverage',
      label: 'The fleet services every required street collectively',
      passed: missing.length === 0,
      detail: missing.length === 0 ? `${needed.size} of ${needed.size} service obligations fulfilled across the fleet.` : `Missing: ${missing.slice(0, 8).join(', ')}`,
    },
    { id: 'classification', label: 'Service, repeat and deadhead labels are correct', passed: kindsOk, detail: kindsOk ? 'Checked fleet-wide in vehicle order.' : 'A step is mislabelled.' },
  ];
  return { ok: checks.every((c) => c.passed), checks, perVehicle, coverage: { obligations: needed.size, covered: needed.size - missing.length, missingEdgeIds, sharedEdgeIds } };
}
