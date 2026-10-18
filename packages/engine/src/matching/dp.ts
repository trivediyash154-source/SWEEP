/**
 * Exact minimum-cost perfect matching by dynamic programming over subsets.
 * f(S) = min cost to perfectly match the vertex set S; the lowest vertex of S
 * is paired with every other member in turn. O(2^k * k) time and memory.
 * Also counts how many distinct pairings achieve the optimum (ties are exact
 * because costs are integers).
 *
 * Used as an independent cross-check of the blossom algorithm for small k.
 */
export function dpMinCostPerfectMatching(k: number, cost: (i: number, j: number) => number): { pairs: Array<[number, number]>; total: number; optimalCount: number } {
  if (k === 0) return { pairs: [], total: 0, optimalCount: 1 };
  if (k % 2 !== 0) throw new Error('dpMinCostPerfectMatching: odd number of vertices');
  if (k > 24) throw new Error('dpMinCostPerfectMatching: k too large');
  const full = (1 << k) - 1;
  const f = new Float64Array(1 << k).fill(Infinity);
  const count = new Float64Array(1 << k);
  const choice = new Int32Array(1 << k).fill(-1);
  f[0] = 0;
  count[0] = 1;
  // Iterate masks in increasing order; only masks with even popcount whose
  // complement's lowest element is matched next are meaningful.
  for (let mask = 1; mask <= full; mask++) {
    // lowest set bit
    const i = 31 - Math.clz32(mask & -mask);
    const rest = mask & ~(1 << i);
    let best = Infinity;
    let bestJ = -1;
    let ways = 0;
    for (let j = i + 1; j < k; j++) {
      if (!(rest & (1 << j))) continue;
      const sub = rest & ~(1 << j);
      const val = f[sub]!;
      if (!Number.isFinite(val)) continue;
      const c = val + cost(i, j);
      if (c < best) {
        best = c;
        bestJ = j;
        ways = count[sub]!;
      } else if (c === best) {
        ways += count[sub]!;
      }
    }
    f[mask] = best;
    choice[mask] = bestJ;
    count[mask] = ways;
  }
  const pairs: Array<[number, number]> = [];
  let mask = full;
  while (mask) {
    const i = 31 - Math.clz32(mask & -mask);
    const j = choice[mask]!;
    pairs.push([i, j]);
    mask &= ~((1 << i) | (1 << j));
  }
  return { pairs, total: f[full]!, optimalCount: count[full]! };
}
