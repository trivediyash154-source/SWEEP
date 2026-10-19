/**
 * Uncapacitated minimum-cost flow (transshipment) by successive shortest
 * paths with node potentials (Edmonds–Karp / Tomizawa).
 *
 *   minimise   Σ c(a)·x(a)
 *   subject to out_x(v) − in_x(v) = b(v)   for every vertex v
 *              x(a) ≥ 0, integer
 *
 * Arc costs are non-negative integers (scaled weights), arcs have unbounded
 * capacity and Σ b(v) = 0. Each iteration runs Dijkstra on reduced costs from
 * every vertex that still has supply and augments along a shortest path to
 * the nearest vertex that still has demand. Potentials are updated so that
 * every residual arc keeps a non-negative reduced cost; at termination they
 * form an optimal dual solution, which `verifyFlowOptimality` checks
 * independently (dual feasibility + complementary slackness).
 */

export interface FlowArc {
  tail: number;
  head: number;
  /** Non-negative integer cost. */
  cost: number;
}

export interface FlowSolution {
  feasible: boolean;
  /** Units of flow on each arc (integers). */
  flow: Float64Array;
  cost: number;
  /** Node potentials π; reduced cost of arc a is c(a) + π(tail) − π(head). */
  potential: Float64Array;
  /** Supply that could not be routed (only when infeasible), by vertex. */
  stranded: number[];
  iterations: number;
}

class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.k.length;
  }
  private lt(i: number, j: number): boolean {
    return this.k[i]! < this.k[j]! || (this.k[i] === this.k[j] && this.v[i]! < this.v[j]!);
  }
  private sw(i: number, j: number): void {
    [this.k[i], this.k[j]] = [this.k[j]!, this.k[i]!];
    [this.v[i], this.v[j]] = [this.v[j]!, this.v[i]!];
  }
  push(key: number, val: number): void {
    this.k.push(key);
    this.v.push(val);
    let i = this.k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.lt(i, p)) break;
      this.sw(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.k[0]!, this.v[0]!];
    const lk = this.k.pop()!;
    const lv = this.v.pop()!;
    if (this.k.length > 0) {
      this.k[0] = lk;
      this.v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let s = i;
        if (l < this.k.length && this.lt(l, s)) s = l;
        if (r < this.k.length && this.lt(r, s)) s = r;
        if (s === i) break;
        this.sw(i, s);
        i = s;
      }
    }
    return top;
  }
}

export function minCostFlow(n: number, arcs: FlowArc[], supply: ArrayLike<number>): FlowSolution {
  const m = arcs.length;
  const out: number[][] = Array.from({ length: n }, () => []);
  const inc: number[][] = Array.from({ length: n }, () => []);
  arcs.forEach((a, i) => {
    if (a.tail === a.head) return; // a loop never helps to move flow
    out[a.tail]!.push(i);
    inc[a.head]!.push(i);
  });
  const flow = new Float64Array(m);
  const pi = new Float64Array(n);
  const excess = Float64Array.from({ length: n }, (_, v) => supply[v]!);
  let cost = 0;
  let iterations = 0;
  const dist = new Float64Array(n);
  const done = new Uint8Array(n);
  // predecessor: arc index, encoded as a + 1 for a forward residual arc and −(a + 1) for a reverse one
  const pred = new Int32Array(n);

  for (;;) {
    let anySupply = false;
    for (let v = 0; v < n; v++) if (excess[v]! > 0) anySupply = true;
    if (!anySupply) break;
    iterations++;
    dist.fill(Infinity);
    done.fill(0);
    pred.fill(0);
    const heap = new Heap();
    for (let v = 0; v < n; v++) {
      if (excess[v]! > 0) {
        dist[v] = 0;
        heap.push(0, v);
      }
    }
    let sink = -1;
    let sinkDist = Infinity;
    while (heap.size > 0) {
      const [d, u] = heap.pop();
      if (done[u] || d > dist[u]!) continue;
      done[u] = 1;
      if (excess[u]! < 0) {
        sink = u;
        sinkDist = d;
        break;
      }
      for (const a of out[u]!) {
        const w = arcs[a]!.head;
        const nd = d + arcs[a]!.cost + pi[u]! - pi[w]!;
        if (nd < dist[w]!) {
          dist[w] = nd;
          pred[w] = a + 1;
          heap.push(nd, w);
        }
      }
      for (const a of inc[u]!) {
        if (flow[a]! <= 0) continue;
        const w = arcs[a]!.tail;
        const nd = d - arcs[a]!.cost + pi[u]! - pi[w]!;
        if (nd < dist[w]!) {
          dist[w] = nd;
          pred[w] = -(a + 1);
          heap.push(nd, w);
        }
      }
    }
    if (sink < 0) {
      const stranded: number[] = [];
      for (let v = 0; v < n; v++) if (excess[v]! > 0) stranded.push(v);
      return { feasible: false, flow, cost, potential: pi, stranded, iterations };
    }
    // Potential update (valid with early termination at the sink).
    for (let v = 0; v < n; v++) pi[v] = pi[v]! + (done[v] ? dist[v]! : sinkDist);
    // Walk back to the source to find the bottleneck.
    let amount = -excess[sink]!;
    let v = sink;
    while (pred[v] !== 0) {
      const p = pred[v]!;
      if (p > 0) v = arcs[p - 1]!.tail;
      else {
        amount = Math.min(amount, flow[-p - 1]!);
        v = arcs[-p - 1]!.head;
      }
    }
    amount = Math.min(amount, excess[v]!);
    const source = v;
    v = sink;
    while (pred[v] !== 0) {
      const p = pred[v]!;
      if (p > 0) {
        flow[p - 1] = flow[p - 1]! + amount;
        cost += amount * arcs[p - 1]!.cost;
        v = arcs[p - 1]!.tail;
      } else {
        flow[-p - 1] = flow[-p - 1]! - amount;
        cost -= amount * arcs[-p - 1]!.cost;
        v = arcs[-p - 1]!.head;
      }
    }
    excess[source] = excess[source]! - amount;
    excess[sink] = excess[sink]! + amount;
  }
  return { feasible: true, flow, cost, potential: pi, stranded: [], iterations };
}

/**
 * Independent optimality certificate for an uncapacitated min-cost flow:
 * primal feasibility (conservation), dual feasibility (all reduced costs ≥ 0),
 * complementary slackness (reduced cost = 0 wherever flow > 0), and equality
 * of the primal and dual objectives Σ c·x = Σ b(v)·(−π(v)).
 */
export function verifyFlowOptimality(
  n: number,
  arcs: FlowArc[],
  supply: ArrayLike<number>,
  flow: ArrayLike<number>,
  potential: ArrayLike<number>,
): { ok: boolean; detail: string } {
  const net = new Float64Array(n);
  let primal = 0;
  for (let a = 0; a < arcs.length; a++) {
    const x = flow[a]!;
    if (x < 0 || !Number.isInteger(x)) return { ok: false, detail: `Arc ${a} carries an invalid flow ${x}.` };
    const { tail, head, cost } = arcs[a]!;
    net[tail] = net[tail]! + x;
    net[head] = net[head]! - x;
    primal += x * cost;
    if (tail === head) continue;
    const reduced = cost + potential[tail]! - potential[head]!;
    if (reduced < 0) return { ok: false, detail: `Arc ${a} has negative reduced cost ${reduced}.` };
    if (x > 0 && reduced !== 0) return { ok: false, detail: `Arc ${a} carries flow but has reduced cost ${reduced}.` };
  }
  let dual = 0;
  for (let v = 0; v < n; v++) {
    if (net[v] !== supply[v]) return { ok: false, detail: `Vertex ${v} is not balanced by the flow.` };
    dual += supply[v]! * -potential[v]!;
  }
  if (primal !== dual) return { ok: false, detail: `Primal cost ${primal} differs from dual value ${dual}.` };
  return { ok: true, detail: 'Conservation, dual feasibility, complementary slackness and equal objectives hold.' };
}

/**
 * Decompose an acyclic-after-cancellation flow into supply→demand paths.
 * Zero-cost cycles (possible with zero-weight arcs) are cancelled first; they
 * add nothing to the cost but would break the "paths start and end at
 * imbalanced vertices" structure the route construction relies on.
 */
export function decomposeFlow(
  n: number,
  arcs: FlowArc[],
  supply: ArrayLike<number>,
  flowIn: ArrayLike<number>,
): { paths: { from: number; to: number; units: number; arcs: number[] }[]; cancelledCycleCost: number } {
  const f = Float64Array.from(flowIn);
  const out: number[][] = Array.from({ length: n }, () => []);
  arcs.forEach((a, i) => {
    if (a.tail !== a.head) out[a.tail]!.push(i);
  });
  const ptr = new Int32Array(n);
  const nextArc = (u: number): number => {
    const list = out[u]!;
    while (ptr[u]! < list.length && f[list[ptr[u]!]!]! <= 0) ptr[u] = ptr[u]! + 1;
    return ptr[u]! < list.length ? list[ptr[u]!]! : -1;
  };
  const remSupply = Float64Array.from({ length: n }, (_, v) => Math.max(0, supply[v]!));
  const remDemand = Float64Array.from({ length: n }, (_, v) => Math.max(0, -supply[v]!));
  const paths: { from: number; to: number; units: number; arcs: number[] }[] = [];
  let cancelledCycleCost = 0;
  for (let s = 0; s < n; s++) {
    while (remSupply[s]! > 0) {
      const walkV: number[] = [s];
      const walkA: number[] = [];
      const pos = new Map<number, number>([[s, 0]]);
      let u = s;
      // s has supply, so it has no demand: walk until a vertex with remaining demand.
      while (!(remDemand[u]! > 0)) {
        const a = nextArc(u);
        if (a < 0) throw new Error('decomposeFlow: flow is not conserved');
        const w = arcs[a]!.head;
        walkA.push(a);
        if (pos.has(w)) {
          // Cancel the cycle w → … → w.
          const start = pos.get(w)!;
          const cyc = walkA.slice(start);
          let amt = Infinity;
          for (const c of cyc) amt = Math.min(amt, f[c]!);
          for (const c of cyc) {
            f[c] = f[c]! - amt;
            cancelledCycleCost += amt * arcs[c]!.cost;
          }
          for (const x of walkV.slice(start + 1)) pos.delete(x);
          walkV.length = start + 1;
          walkA.length = start;
          u = w;
          continue;
        }
        pos.set(w, walkV.length);
        walkV.push(w);
        u = w;
      }
      let amt = Math.min(remSupply[s]!, remDemand[u]!);
      for (const a of walkA) amt = Math.min(amt, f[a]!);
      for (const a of walkA) f[a] = f[a]! - amt;
      remSupply[s] = remSupply[s]! - amt;
      remDemand[u] = remDemand[u]! - amt;
      paths.push({ from: s, to: u, units: amt, arcs: walkA.slice() });
    }
  }
  return { paths, cancelledCycleCost };
}
