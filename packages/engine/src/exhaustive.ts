import type { Graph } from './types.js';
import { indexGraph, UnionFind } from './graph.js';
import { fromScaled } from './units.js';

/**
 * Exhaustive reference solver for SMALL instances (testing only).
 *
 * It searches over every multiset X of extra edge copies with multiplicity in
 * {0, …, maxCopies} such that (required edges) + X has all degrees even and is
 * connected, and returns the minimum extra cost. It shares no code with the
 * production path (no shortest paths, no matching), so agreement between the
 * two is strong evidence of correctness. Complexity O((maxCopies+1)^m · m).
 */
export function exhaustiveOptimalTotal(graph: Graph, maxCopies = 1): { total: number; added: number } | null {
  const ig = indexGraph(graph);
  if (ig.m > 20) throw new Error('exhaustiveOptimalTotal: too many edges');
  const base = new Int32Array(ig.n);
  let requiredScaled = 0;
  for (let k = 0; k < ig.m; k++) {
    if (!ig.required[k]) continue;
    requiredScaled += ig.ew[k]!;
    base[ig.eu[k]!] = base[ig.eu[k]!]! + 1;
    base[ig.ev[k]!] = base[ig.ev[k]!]! + 1;
  }
  const mult = new Int32Array(ig.m);
  let best = Infinity;
  const radix = maxCopies + 1;
  const total = radix ** ig.m;
  for (let code = 0; code < total; code++) {
    let c = code;
    let cost = 0;
    for (let k = 0; k < ig.m; k++) {
      mult[k] = c % radix;
      c = Math.floor(c / radix);
      cost += mult[k]! * ig.ew[k]!;
    }
    if (cost >= best) continue;
    const deg = Int32Array.from(base);
    for (let k = 0; k < ig.m; k++) {
      if (!mult[k]) continue;
      deg[ig.eu[k]!] = deg[ig.eu[k]!]! + mult[k]!;
      deg[ig.ev[k]!] = deg[ig.ev[k]!]! + mult[k]!;
    }
    if (!deg.every((d) => d % 2 === 0)) continue;
    const uf = new UnionFind(ig.n);
    for (let k = 0; k < ig.m; k++) if (ig.required[k] || mult[k]) uf.union(ig.eu[k]!, ig.ev[k]!);
    let root = -1;
    let connected = true;
    for (let v = 0; v < ig.n && connected; v++) {
      if (deg[v] === 0) continue;
      const r = uf.find(v);
      if (root === -1) root = r;
      else if (r !== root) connected = false;
    }
    if (connected) best = cost;
  }
  if (!Number.isFinite(best)) return null;
  return { total: fromScaled(requiredScaled + best), added: fromScaled(best) };
}
