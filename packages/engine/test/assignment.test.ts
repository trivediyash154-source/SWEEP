import { describe, expect, it } from 'vitest';
import { sparseAssignment } from '../src/coverage/assignment.js';
import { minCostFlow, type FlowArc } from '../src/mincostflow.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Random sparse instance with integer costs; every row keeps at least one edge. */
function instance(n: number, seed: number, density: number) {
  const r = rng(seed);
  const rows: [number, number][][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (r() < density || j === (i * 7 + 3) % n) rows[i]!.push([j, Math.floor(r() * 1000)]); // integer costs, as the coverage code passes (scaled distances)
  const rowOff = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) rowOff[i + 1] = rowOff[i]! + rows[i]!.length;
  const col = new Int32Array(rowOff[n]!);
  const cost = new Float64Array(rowOff[n]!);
  let e = 0;
  for (const row of rows)
    for (const [j, c] of row) {
      col[e] = j;
      cost[e] = c;
      e++;
    }
  return { rowOff, col, cost, rows };
}

function bruteForce(n: number, rows: [number, number][][]): number {
  const c = rows.map((row) => new Map(row));
  let best = Infinity;
  const used = new Uint8Array(n);
  const go = (i: number, acc: number) => {
    if (acc >= best) return;
    if (i === n) {
      best = acc;
      return;
    }
    for (const [j, w] of c[i]!) {
      if (used[j]) continue;
      used[j] = 1;
      go(i + 1, acc + w);
      used[j] = 0;
    }
  };
  go(0, 0);
  return best;
}

describe('sparse assignment (Jonker–Volgenant)', () => {
  it('finds the optimum on small instances, with feasible and complementary duals', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const n = 2 + (seed % 6);
      const { rowOff, col, cost, rows } = instance(n, seed, 0.6);
      const res = sparseAssignment(n, rowOff, col, cost);
      const opt = bruteForce(n, rows);
      if (!Number.isFinite(opt)) {
        expect(res).toBeNull();
        continue;
      }
      expect(res).not.toBeNull();
      expect(Math.abs(res!.cost - opt)).toBeLessThan(1e-9);
      for (let i = 0; i < n; i++)
        for (let e = rowOff[i]!; e < rowOff[i + 1]!; e++) {
          const slack = cost[e]! - res!.u[i]! - res!.v[col[e]!]!;
          expect(slack).toBeGreaterThanOrEqual(-1e-9);
          if (res!.rowSol[i] === col[e]) expect(Math.abs(slack)).toBeLessThan(1e-9);
        }
      // Dual objective equals the primal optimum (strong duality).
      let dual = 0;
      for (let i = 0; i < n; i++) dual += res!.u[i]! + res!.v[i]!;
      expect(Math.abs(dual - opt)).toBeLessThan(1e-6);
    }
  });

  it('agrees with the general min-cost flow on larger sparse instances', () => {
    for (let seed = 100; seed < 110; seed++) {
      const n = 120;
      const { rowOff, col, cost } = instance(n, seed, 0.05);
      const res = sparseAssignment(n, rowOff, col, cost);
      const arcs: FlowArc[] = [];
      for (let i = 0; i < n; i++) for (let e = rowOff[i]!; e < rowOff[i + 1]!; e++) arcs.push({ tail: i, head: n + col[e]!, cost: cost[e]! });
      const supply = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) {
        supply[i] = 1;
        supply[n + i] = -1;
      }
      const flow = minCostFlow(2 * n, arcs, supply);
      expect(res === null).toBe(!flow.feasible);
      if (res) expect(Math.abs(res.cost - flow.cost)).toBeLessThan(1e-6);
    }
  });

  it('reports instances without a perfect matching', () => {
    // Rows 0 and 1 both only reach column 0.
    const res = sparseAssignment(2, Int32Array.from([0, 1, 2]), Int32Array.from([0, 0]), Float64Array.from([1, 2]));
    expect(res).toBeNull();
  });
});
