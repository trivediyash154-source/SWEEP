/**
 * Hierholzer's algorithm (iterative) for an Euler circuit in a connected
 * undirected multigraph whose vertices all have even degree. O(E).
 *
 * Input edges are given as endpoint pairs; the output is the sequence of edge
 * indices in traversal order together with the vertex reached after each one.
 * Adjacency is scanned in edge-index order, so the result is deterministic.
 */
export function eulerCircuit(n: number, ends: Array<[number, number]>, start: number): { edges: number[]; vertices: number[] } {
  const adj: number[][] = Array.from({ length: n }, () => []);
  ends.forEach(([u, v], idx) => {
    adj[u]!.push(idx);
    if (u !== v) adj[v]!.push(idx);
  });
  const used = new Uint8Array(ends.length);
  const ptr = new Int32Array(n);
  const stackV: number[] = [start];
  const stackE: number[] = [-1];
  const outEdges: number[] = [];
  const outVerts: number[] = [];
  while (stackV.length > 0) {
    const v = stackV[stackV.length - 1]!;
    const list = adj[v]!;
    while (ptr[v]! < list.length && used[list[ptr[v]!]!]) ptr[v] = ptr[v]! + 1;
    if (ptr[v]! < list.length) {
      const idx = list[ptr[v]!]!;
      used[idx] = 1;
      const [a, b] = ends[idx]!;
      const w = a === v ? b : a;
      stackV.push(w);
      stackE.push(idx);
    } else {
      stackV.pop();
      const e = stackE.pop()!;
      if (e !== -1) {
        outEdges.push(e);
        outVerts.push(v);
      }
    }
  }
  outEdges.reverse();
  outVerts.reverse();
  return { edges: outEdges, vertices: outVerts };
}
