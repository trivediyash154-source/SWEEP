import { MinHeap } from './arcs.js';

export interface AssignmentResult {
  /** Column assigned to each row. */
  rowSol: Int32Array;
  /** Row assigned to each column. */
  colSol: Int32Array;
  /** Dual potentials: u_i + v_j ≤ c_ij on every edge, with equality on assigned edges. */
  u: Float64Array;
  v: Float64Array;
  cost: number;
}

/**
 * Sparse linear assignment problem (n rows, n columns, edges in CSR form), solved
 * exactly in the style of Jonker and Volgenant (1987):
 *
 *  1. Column reduction: v_j = min_i c_ij, and each column is assigned to its
 *     cheapest row when that row is still free. Then u_i = 0 for every row and
 *     u_i + v_j ≤ c_ij holds on every edge, with equality on the assigned edges.
 *  2. For each free row, a shortest augmenting path in the reduced costs
 *     c_ij − u_i − v_j ≥ 0 (Dijkstra over columns, stopped at the first free
 *     column reached), then the dual update v_j += d_j − μ for the columns
 *     settled before it, where μ is the length of the path found. With
 *     u_i = c_{i,σ(i)} − v_{σ(i)} for every assigned row, this keeps all reduced
 *     costs non-negative and the assigned ones zero.
 *
 * At the end the duals (u, v) are feasible and complementary to the assignment,
 * so both are optimal. Returns null when no perfect matching exists.
 */
export function sparseAssignment(n: number, rowOff: Int32Array, col: Int32Array, cost: Float64Array): AssignmentResult | null {
  const v = new Float64Array(n).fill(Infinity);
  const argRow = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++)
    for (let e = rowOff[i]!; e < rowOff[i + 1]!; e++) {
      const j = col[e]!;
      if (cost[e]! < v[j]! || (cost[e]! === v[j]! && i < argRow[j]!)) {
        v[j] = cost[e]!;
        argRow[j] = i;
      }
    }
  for (let j = 0; j < n; j++) if (argRow[j]! < 0) return null; // a column no row can take
  const rowSol = new Int32Array(n).fill(-1);
  const colSol = new Int32Array(n).fill(-1);
  for (let j = 0; j < n; j++) {
    const i = argRow[j]!;
    if (rowSol[i]! < 0) {
      rowSol[i] = j;
      colSol[j] = i;
    }
  }
  // Cost of the edge (i, j); rows are short, so a linear scan is cheap.
  const edgeCost = (i: number, j: number): number => {
    for (let e = rowOff[i]!; e < rowOff[i + 1]!; e++) if (col[e] === j) return cost[e]!;
    return Infinity;
  };
  const uOf = (i: number): number => edgeCost(i, rowSol[i]!) - v[rowSol[i]!]!;

  const dist = new Float64Array(n).fill(Infinity);
  const predRow = new Int32Array(n).fill(-1);
  const settled = new Uint8Array(n);
  const touched: number[] = [];
  const ready: number[] = [];
  const heap = new MinHeap();
  for (let f = 0; f < n; f++) {
    if (rowSol[f]! >= 0) continue;
    heap.clear();
    for (const j of touched) {
      dist[j] = Infinity;
      predRow[j] = -1;
      settled[j] = 0;
    }
    touched.length = 0;
    ready.length = 0;
    for (let e = rowOff[f]!; e < rowOff[f + 1]!; e++) {
      const j = col[e]!;
      const d = cost[e]! - v[j]!;
      if (d < dist[j]!) {
        if (dist[j] === Infinity) touched.push(j);
        dist[j] = d;
        predRow[j] = f;
        heap.push(d, j);
      }
    }
    let free = -1;
    let mu = 0;
    while (heap.size > 0) {
      heap.popMin();
      const j = heap.topVal;
      const dj = heap.topKey;
      if (settled[j] || dj > dist[j]!) continue;
      settled[j] = 1;
      if (colSol[j]! < 0) {
        free = j;
        mu = dj;
        break;
      }
      ready.push(j);
      const i = colSol[j]!;
      const ui = edgeCost(i, j) - v[j]!;
      for (let e = rowOff[i]!; e < rowOff[i + 1]!; e++) {
        const k = col[e]!;
        if (settled[k]) continue;
        const nd = dj + cost[e]! - ui - v[k]!;
        if (nd < dist[k]!) {
          if (dist[k] === Infinity) touched.push(k);
          dist[k] = nd;
          predRow[k] = i;
          heap.push(nd, k);
        }
      }
    }
    if (free < 0) return null; // row f cannot be matched
    for (const j of ready) v[j] = v[j]! + dist[j]! - mu;
    // Augment along the predecessor chain back to row f.
    let j = free;
    for (;;) {
      const i = predRow[j]!;
      const prev = rowSol[i]!;
      rowSol[i] = j;
      colSol[j] = i;
      if (i === f) break;
      j = prev;
    }
  }
  const u = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    u[i] = uOf(i);
    total += edgeCost(i, rowSol[i]!);
  }
  return { rowSol, colSol, u, v, cost: total };
}
