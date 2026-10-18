import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { dpMinCostPerfectMatching, maxWeightMatching, minCostPerfectMatchingComplete, greedyPairing } from '../src/index.js';

function bruteMaxWeight(n: number, edges: Array<[number, number, number]>, maxCard: boolean): number {
  // returns best weight among (maximum-cardinality, if maxCard) matchings
  let bestW = -Infinity;
  let bestC = -1;
  const used = new Uint8Array(n);
  const rec = (k: number, w: number, c: number): void => {
    if (k === edges.length) {
      if (maxCard) {
        if (c > bestC || (c === bestC && w > bestW)) {
          bestC = c;
          bestW = w;
        }
      } else if (w > bestW) bestW = w;
      return;
    }
    rec(k + 1, w, c);
    const [i, j, wt] = edges[k]!;
    if (!used[i] && !used[j]) {
      used[i] = used[j] = 1;
      rec(k + 1, w + wt, c + 1);
      used[i] = used[j] = 0;
    }
  };
  rec(0, 0, 0);
  return bestW;
}

describe('Edmonds blossom (general max-weight matching)', () => {
  it('agrees with brute force on random sparse graphs, with and without max cardinality', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        fc.array(fc.tuple(fc.nat(7), fc.nat(7), fc.integer({ min: 0, max: 30 })), { minLength: 1, maxLength: 14 }),
        fc.boolean(),
        (n, raw, maxCard) => {
          const seen = new Set<string>();
          const edges: Array<[number, number, number]> = [];
          for (const [a, b, w] of raw) {
            const i = a % n;
            const j = b % n;
            if (i === j) continue;
            const key = i < j ? `${i}-${j}` : `${j}-${i}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push([i, j, w]);
          }
          if (edges.length === 0) return;
          const { mate, certificateVerified } = maxWeightMatching(edges, maxCard);
          let w = 0;
          for (const [i, j, wt] of edges) if (mate[i] === j) w += wt;
          expect(certificateVerified).toBe(true);
          expect(w).toBe(bruteMaxWeight(Math.max(...edges.flatMap(([i, j]) => [i, j])) + 1, edges, maxCard));
        },
      ),
      { numRuns: 1500, seed: 424242 },
    );
  });
});

describe('minimum-cost perfect matching on complete graphs', () => {
  it('blossom equals subset DP on random integer metrics (k ≤ 14)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 7 }), fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 91, maxLength: 91 }), (half, vals) => {
        const k = half * 2;
        const C: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
        let t = 0;
        for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) C[i]![j] = C[j]![i] = vals[t++ % vals.length]!;
        const cost = (i: number, j: number): number => C[i]![j]!;
        const b = minCostPerfectMatchingComplete(k, cost);
        const d = dpMinCostPerfectMatching(k, cost);
        expect(b.total).toBe(d.total);
        expect(b.certificateVerified).toBe(true);
        for (let i = 0; i < k; i++) expect(b.mate[b.mate[i]!]).toBe(i);
        expect(greedyPairing(k, cost).total).toBeGreaterThanOrEqual(d.total);
      }),
      { numRuns: 800, seed: 7 },
    );
  });

  it('counts tied optimal pairings exactly', () => {
    // 4 points on a unit square: sides 1, diagonals 2 → two optimal pairings
    const C = [
      [0, 1, 2, 1],
      [1, 0, 1, 2],
      [2, 1, 0, 1],
      [1, 2, 1, 0],
    ];
    const d = dpMinCostPerfectMatching(4, (i, j) => C[i]![j]!);
    expect(d.total).toBe(2);
    expect(d.optimalCount).toBe(2);
    // all-equal costs on 6 points → 5!! = 15 optimal pairings
    expect(dpMinCostPerfectMatching(6, () => 3).optimalCount).toBe(15);
  });

  it('handles larger instances with a verified certificate', () => {
    const k = 120;
    let s = 12345;
    const rnd = (): number => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pts = Array.from({ length: k }, () => [Math.round(rnd() * 10000), Math.round(rnd() * 10000)] as const);
    const cost = (i: number, j: number): number => Math.abs(pts[i]![0] - pts[j]![0]) + Math.abs(pts[i]![1] - pts[j]![1]);
    const r = minCostPerfectMatchingComplete(k, cost);
    expect(r.certificateVerified).toBe(true);
    expect(r.total).toBeLessThanOrEqual(greedyPairing(k, cost).total);
  });
});
