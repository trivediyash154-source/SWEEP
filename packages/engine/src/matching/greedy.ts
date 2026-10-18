/**
 * Greedy pairing heuristic used ONLY as a comparison baseline: repeatedly pair
 * the two closest unpaired vertices. It always yields a valid perfect pairing,
 * but it is not optimal in general (see the "greedy-trap" example).
 */
export function greedyPairing(k: number, cost: (i: number, j: number) => number): { pairs: Array<[number, number]>; total: number } {
  const candidates: Array<[number, number, number]> = [];
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) candidates.push([cost(i, j), i, j]);
  candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const used = new Uint8Array(k);
  const pairs: Array<[number, number]> = [];
  let total = 0;
  for (const [c, i, j] of candidates) {
    if (used[i] || used[j]) continue;
    used[i] = used[j] = 1;
    pairs.push([i, j]);
    total += c;
  }
  return { pairs, total };
}
