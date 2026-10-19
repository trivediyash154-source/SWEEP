import type { Graph, TwoWayService } from './types.js';
import { toScaled, fromScaled } from './units.js';
import { isOneway } from './validate.js';

/**
 * Independent exact method for small instances, used to cross-check the
 * directed and mixed solvers (and, with every street two-way, the undirected
 * one). It shares no code with them: it rebuilds the permitted arcs from the
 * raw graph and runs Dijkstra over states (vertex, set of fulfilled service
 * obligations). The answer is the length of the shortest closed walk from the
 * depot that fulfils every obligation, or null if none exists.
 *
 * Obligations:
 *  - one-way required street: one traversal u→v;
 *  - two-way required street, 'both': one traversal in each direction (a loop: one traversal);
 *  - two-way required street, 'either': one traversal in either direction.
 *
 * Cost is exponential in the number of obligations; callers keep it ≤ 14.
 */
export const STATE_SEARCH_MAX_OBLIGATIONS = 14;

export function shortestCoveringWalk(graph: Graph, opts: { depotId: string; twoWay: TwoWayService; maxStates?: number }): number | null {
  const index = new Map(graph.vertices.map((v, i) => [v.id, i]));
  const n = graph.vertices.length;
  const arcs: { tail: number; head: number; cost: number; mask: number }[] = [];
  let r = 0;
  for (const e of graph.edges) {
    const u = index.get(e.u)!;
    const v = index.get(e.v)!;
    const fwd = toScaled(e.weight);
    const back = toScaled(e.reverseWeight ?? e.weight);
    if (isOneway(e) || u === v) {
      const bit = e.required ? 1 << r++ : 0;
      arcs.push({ tail: u, head: v, cost: fwd, mask: bit });
    } else if (!e.required) {
      arcs.push({ tail: u, head: v, cost: fwd, mask: 0 }, { tail: v, head: u, cost: back, mask: 0 });
    } else if (opts.twoWay === 'both') {
      const b1 = 1 << r++;
      const b2 = 1 << r++;
      arcs.push({ tail: u, head: v, cost: fwd, mask: b1 }, { tail: v, head: u, cost: back, mask: b2 });
    } else {
      const bit = 1 << r++;
      arcs.push({ tail: u, head: v, cost: fwd, mask: bit }, { tail: v, head: u, cost: back, mask: bit });
    }
  }
  if (r > STATE_SEARCH_MAX_OBLIGATIONS) throw new Error(`shortestCoveringWalk: ${r} obligations exceed the limit of ${STATE_SEARCH_MAX_OBLIGATIONS}`);
  const full = (1 << r) - 1;
  const states = n << r;
  if (states > (opts.maxStates ?? 4_000_000)) throw new Error('shortestCoveringWalk: state space too large');
  const depot = index.get(opts.depotId);
  if (depot === undefined) throw new Error('shortestCoveringWalk: unknown depot');
  const out: number[][] = Array.from({ length: n }, () => []);
  arcs.forEach((a, i) => out[a.tail]!.push(i));

  const dist = new Float64Array(states).fill(Infinity);
  const start = depot << r;
  const goal = (depot << r) | full;
  dist[start] = 0;
  // Simple binary heap of [dist, state].
  const hk: number[] = [0];
  const hv: number[] = [start];
  const push = (k: number, v: number): void => {
    hk.push(k);
    hv.push(v);
    let i = hk.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hk[p]! <= hk[i]!) break;
      [hk[p], hk[i]] = [hk[i]!, hk[p]!];
      [hv[p], hv[i]] = [hv[i]!, hv[p]!];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top: [number, number] = [hk[0]!, hv[0]!];
    const lk = hk.pop()!;
    const lv = hv.pop()!;
    if (hk.length > 0) {
      hk[0] = lk;
      hv[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const rr = l + 1;
        let s = i;
        if (l < hk.length && hk[l]! < hk[s]!) s = l;
        if (rr < hk.length && hk[rr]! < hk[s]!) s = rr;
        if (s === i) break;
        [hk[s], hk[i]] = [hk[i]!, hk[s]!];
        [hv[s], hv[i]] = [hv[i]!, hv[s]!];
        i = s;
      }
    }
    return top;
  };
  while (hk.length > 0) {
    const [d, st] = pop();
    if (d > dist[st]!) continue;
    if (st === goal) return fromScaled(d);
    const v = st >> r;
    const mask = st & full;
    for (const ai of out[v]!) {
      const a = arcs[ai]!;
      const ns = (a.head << r) | (mask | a.mask);
      const nd = d + a.cost;
      if (nd < dist[ns]!) {
        dist[ns] = nd;
        push(nd, ns);
      }
    }
  }
  return Number.isFinite(dist[goal]!) ? fromScaled(dist[goal]!) : null;
}
