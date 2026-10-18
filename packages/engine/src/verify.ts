import type { CheckResult, Graph, RouteStep } from './types.js';
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
