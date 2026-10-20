/**
 * Maximum-weight matching in general graphs (Edmonds' blossom algorithm,
 * primal–dual, O(n^3)).
 *
 * This is a TypeScript port of the well-known public-domain reference
 * implementation by Joris van Rantwijk (mwmatching.py), which follows
 * Z. Galil, "Efficient Algorithms for Finding Maximum Matching in Graphs",
 * ACM Computing Surveys, 1986. The structure and variable names are kept close
 * to the original so the port can be audited line by line.
 *
 * SWEEP uses it with maxCardinality = true on a complete graph with an even
 * number of vertices, which yields a maximum-weight PERFECT matching. Minimum
 * cost perfect matching is obtained by using weights (C - cost).
 *
 * In addition to the matching, `verifyOptimum` checks the LP-duality
 * optimality conditions (dual feasibility + complementary slackness). When it
 * passes, the returned matching is provably optimal for the given weights.
 * With integer weights all dual values are multiples of 1/2, so the
 * computation is exact in IEEE-754 doubles for the magnitudes SWEEP permits.
 */

export interface BlossomResult {
  /** mate[v] = vertex matched to v, or -1. */
  mate: Int32Array;
  /** True if the LP-duality optimality certificate verified. */
  certificateVerified: boolean;
}

export type WeightedEdgeList = Array<[number, number, number]>;

export function maxWeightMatching(edges: WeightedEdgeList, maxCardinality: boolean): BlossomResult {
  if (edges.length === 0) return { mate: new Int32Array(0), certificateVerified: true };

  const nedge = edges.length;
  let nvertex = 0;
  for (const [i, j] of edges) {
    if (i < 0 || j < 0 || i === j) throw new Error('maxWeightMatching: invalid edge');
    if (i >= nvertex) nvertex = i + 1;
    if (j >= nvertex) nvertex = j + 1;
  }

  let maxweight = 0;
  for (const e of edges) if (e[2] > maxweight) maxweight = e[2];
  const EI = new Int32Array(nedge);
  const EJ = new Int32Array(nedge);
  const EW = new Float64Array(nedge);
  for (let k = 0; k < nedge; k++) {
    EI[k] = edges[k]![0];
    EJ[k] = edges[k]![1];
    EW[k] = edges[k]![2];
  }

  // endpoint[p] is the vertex to which endpoint p is attached.
  const endpoint = new Int32Array(2 * nedge);
  for (let p = 0; p < 2 * nedge; p++) endpoint[p] = edges[p >> 1]![p % 2]!;

  // neighbend[v] is the list of remote endpoints of the edges attached to v,
  // stored in compressed (CSR) form: nbStart[v] .. nbStart[v+1].
  const nbStart = new Int32Array(nvertex + 1);
  for (let k = 0; k < nedge; k++) {
    nbStart[EI[k]! + 1] = nbStart[EI[k]! + 1]! + 1;
    nbStart[EJ[k]! + 1] = nbStart[EJ[k]! + 1]! + 1;
  }
  for (let v = 0; v < nvertex; v++) nbStart[v + 1] = nbStart[v + 1]! + nbStart[v]!;
  const nbList = new Int32Array(2 * nedge);
  {
    const fill = nbStart.slice(0, nvertex);
    for (let k = 0; k < nedge; k++) {
      nbList[fill[EI[k]!]!] = 2 * k + 1;
      fill[EI[k]!] = fill[EI[k]!]! + 1;
      nbList[fill[EJ[k]!]!] = 2 * k;
      fill[EJ[k]!] = fill[EJ[k]!]! + 1;
    }
  }

  const mate = new Int32Array(nvertex).fill(-1);
  const label = new Int32Array(2 * nvertex);
  const labelend = new Int32Array(2 * nvertex).fill(-1);
  const inblossom = new Int32Array(nvertex);
  for (let v = 0; v < nvertex; v++) inblossom[v] = v;
  const blossomparent = new Int32Array(2 * nvertex).fill(-1);
  const blossomchilds: (number[] | null)[] = new Array(2 * nvertex).fill(null);
  const blossombase = new Int32Array(2 * nvertex);
  for (let v = 0; v < nvertex; v++) blossombase[v] = v;
  for (let b = nvertex; b < 2 * nvertex; b++) blossombase[b] = -1;
  const blossomendps: (number[] | null)[] = new Array(2 * nvertex).fill(null);
  const bestedge = new Int32Array(2 * nvertex).fill(-1);
  const blossombestedges: (number[] | null)[] = new Array(2 * nvertex).fill(null);
  const unusedblossoms: number[] = [];
  for (let b = nvertex; b < 2 * nvertex; b++) unusedblossoms.push(b);
  // dualvar[v] = 2*u(v) for vertices; dualvar[b] = z(b) for blossoms.
  const dualvar = new Float64Array(2 * nvertex);
  for (let v = 0; v < nvertex; v++) dualvar[v] = maxweight;
  const allowedge = new Uint8Array(nedge);
  let queue: number[] = [];

  const at = <T,>(arr: T[], idx: number): T => arr[idx < 0 ? idx + arr.length : idx]!;

  // Return 2 * slack of edge k (does not work inside blossoms).
  const slack = (k: number): number => dualvar[EI[k]!]! + dualvar[EJ[k]!]! - 2 * EW[k]!;

  const blossomLeaves = (b: number, out: number[] = []): number[] => {
    if (b < nvertex) out.push(b);
    else for (const t of blossomchilds[b]!) {
      if (t < nvertex) out.push(t);
      else blossomLeaves(t, out);
    }
    return out;
  };

  const assignLabel = (w: number, t: number, p: number): void => {
    const b = inblossom[w]!;
    if (label[w] !== 0 || label[b] !== 0) throw new Error('assignLabel: already labeled');
    label[w] = label[b] = t;
    labelend[w] = labelend[b] = p;
    bestedge[w] = bestedge[b] = -1;
    if (t === 1) {
      queue.push(...blossomLeaves(b));
    } else if (t === 2) {
      const base = blossombase[b]!;
      if (mate[base]! < 0) throw new Error('assignLabel: T-blossom base is single');
      assignLabel(endpoint[mate[base]!]!, 1, mate[base]! ^ 1);
    }
  };

  const scanBlossom = (vIn: number, wIn: number): number => {
    let v = vIn;
    let w = wIn;
    const path: number[] = [];
    let base = -1;
    while (v !== -1 || w !== -1) {
      let b = inblossom[v]!;
      if (label[b]! & 4) {
        base = blossombase[b]!;
        break;
      }
      path.push(b);
      label[b] = 5;
      if (labelend[b] === -1) {
        v = -1;
      } else {
        v = endpoint[labelend[b]!]!;
        b = inblossom[v]!;
        v = endpoint[labelend[b]!]!;
      }
      if (w !== -1) {
        const tmp = v;
        v = w;
        w = tmp;
      }
    }
    for (const b of path) label[b] = 1;
    return base;
  };

  const addBlossom = (base: number, k: number): void => {
    let [v, w] = edges[k]!;
    const bb = inblossom[base]!;
    let bv = inblossom[v]!;
    let bw = inblossom[w]!;
    const b = unusedblossoms.pop();
    if (b === undefined) throw new Error('addBlossom: out of blossom ids');
    blossombase[b] = base;
    blossomparent[b] = -1;
    blossomparent[bb] = b;
    const path: number[] = [];
    const endps: number[] = [];
    blossomchilds[b] = path;
    blossomendps[b] = endps;
    while (bv !== bb) {
      blossomparent[bv] = b;
      path.push(bv);
      endps.push(labelend[bv]!);
      v = endpoint[labelend[bv]!]!;
      bv = inblossom[v]!;
    }
    path.push(bb);
    path.reverse();
    endps.reverse();
    endps.push(2 * k);
    while (bw !== bb) {
      blossomparent[bw] = b;
      path.push(bw);
      endps.push(labelend[bw]! ^ 1);
      w = endpoint[labelend[bw]!]!;
      bw = inblossom[w]!;
    }
    label[b] = 1;
    labelend[b] = labelend[bb]!;
    dualvar[b] = 0;
    for (const leaf of blossomLeaves(b)) {
      if (label[inblossom[leaf]!] === 2) queue.push(leaf);
      inblossom[leaf] = b;
    }
    const bestedgeto = new Int32Array(2 * nvertex).fill(-1);
    for (const sub of path) {
      let nblists: number[][];
      if (blossombestedges[sub] === null) {
        nblists = blossomLeaves(sub).map((leaf) => {
          const out: number[] = [];
          for (let q = nbStart[leaf]!; q < nbStart[leaf + 1]!; q++) out.push(nbList[q]! >> 1);
          return out;
        });
      } else {
        nblists = [blossombestedges[sub]!];
      }
      for (const nblist of nblists) {
        for (const kk of nblist) {
          let [i, j] = edges[kk]!;
          if (inblossom[j] === b) {
            const tmp = i;
            i = j;
            j = tmp;
          }
          void i;
          const bj = inblossom[j]!;
          if (bj !== b && label[bj] === 1 && (bestedgeto[bj] === -1 || slack(kk) < slack(bestedgeto[bj]!))) {
            bestedgeto[bj] = kk;
          }
        }
      }
      blossombestedges[sub] = null;
      bestedge[sub] = -1;
    }
    const list: number[] = [];
    for (const kk of bestedgeto) if (kk !== -1) list.push(kk);
    blossombestedges[b] = list;
    bestedge[b] = -1;
    for (const kk of list) if (bestedge[b] === -1 || slack(kk) < slack(bestedge[b]!)) bestedge[b] = kk;
  };

  const expandBlossom = (b: number, endstage: boolean): void => {
    const childs = blossomchilds[b]!;
    for (const s of childs) {
      blossomparent[s] = -1;
      if (s < nvertex) inblossom[s] = s;
      else if (endstage && dualvar[s] === 0) expandBlossom(s, endstage);
      else for (const leaf of blossomLeaves(s)) inblossom[leaf] = s;
    }
    if (!endstage && label[b] === 2) {
      const endps = blossomendps[b]!;
      const entrychild = inblossom[endpoint[labelend[b]! ^ 1]!]!;
      let j = childs.indexOf(entrychild);
      let jstep: number;
      let endptrick: number;
      if (j & 1) {
        j -= childs.length;
        jstep = 1;
        endptrick = 0;
      } else {
        jstep = -1;
        endptrick = 1;
      }
      let p = labelend[b]!;
      while (j !== 0) {
        label[endpoint[p ^ 1]!] = 0;
        label[endpoint[at(endps, j - endptrick) ^ endptrick ^ 1]!] = 0;
        assignLabel(endpoint[p ^ 1]!, 2, p);
        allowedge[at(endps, j - endptrick) >> 1] = 1;
        j += jstep;
        p = at(endps, j - endptrick) ^ endptrick;
        allowedge[p >> 1] = 1;
        j += jstep;
      }
      const bv = at(childs, j);
      label[endpoint[p ^ 1]!] = label[bv] = 2;
      labelend[endpoint[p ^ 1]!] = labelend[bv] = p;
      bestedge[bv] = -1;
      j += jstep;
      while (at(childs, j) !== entrychild) {
        const sub = at(childs, j);
        if (label[sub] === 1) {
          j += jstep;
          continue;
        }
        let reached = -1;
        for (const leaf of blossomLeaves(sub)) {
          if (label[leaf] !== 0) {
            reached = leaf;
            break;
          }
        }
        if (reached !== -1) {
          label[reached] = 0;
          label[endpoint[mate[blossombase[sub]!]!]!] = 0;
          assignLabel(reached, 2, labelend[reached]!);
        }
        j += jstep;
      }
    }
    label[b] = labelend[b] = -1;
    blossomchilds[b] = blossomendps[b] = null;
    blossombase[b] = -1;
    blossombestedges[b] = null;
    bestedge[b] = -1;
    unusedblossoms.push(b);
  };

  const augmentBlossom = (b: number, v: number): void => {
    let t = v;
    while (blossomparent[t] !== b) t = blossomparent[t]!;
    if (t >= nvertex) augmentBlossom(t, v);
    const childs = blossomchilds[b]!;
    const endps = blossomendps[b]!;
    const i = childs.indexOf(t);
    let j = i;
    let jstep: number;
    let endptrick: number;
    if (i & 1) {
      j -= childs.length;
      jstep = 1;
      endptrick = 0;
    } else {
      jstep = -1;
      endptrick = 1;
    }
    while (j !== 0) {
      j += jstep;
      t = at(childs, j);
      const p = at(endps, j - endptrick) ^ endptrick;
      if (t >= nvertex) augmentBlossom(t, endpoint[p]!);
      j += jstep;
      t = at(childs, j);
      if (t >= nvertex) augmentBlossom(t, endpoint[p ^ 1]!);
      mate[endpoint[p]!] = p ^ 1;
      mate[endpoint[p ^ 1]!] = p;
    }
    blossomchilds[b] = childs.slice(i).concat(childs.slice(0, i));
    blossomendps[b] = endps.slice(i).concat(endps.slice(0, i));
    blossombase[b] = blossombase[blossomchilds[b]![0]!]!;
  };

  const augmentMatching = (k: number): void => {
    const [v, w] = edges[k]!;
    for (const [s0, p0] of [
      [v, 2 * k + 1],
      [w, 2 * k],
    ] as const) {
      let s = s0;
      let p = p0;
      for (;;) {
        const bs = inblossom[s]!;
        if (bs >= nvertex) augmentBlossom(bs, s);
        mate[s] = p;
        if (labelend[bs] === -1) break;
        const tt = endpoint[labelend[bs]!]!;
        const bt = inblossom[tt]!;
        s = endpoint[labelend[bt]!]!;
        const jj = endpoint[labelend[bt]! ^ 1]!;
        if (bt >= nvertex) augmentBlossom(bt, jj);
        mate[jj] = labelend[bt]!;
        p = labelend[bt]! ^ 1;
      }
    }
  };

  const verifyOptimum = (): boolean => {
    let minVertexDual = Infinity;
    for (let v = 0; v < nvertex; v++) minVertexDual = Math.min(minVertexDual, dualvar[v]!);
    const vdualoffset = maxCardinality ? Math.max(0, -minVertexDual) : 0;
    if (minVertexDual + vdualoffset < 0) return false;
    for (let b = nvertex; b < 2 * nvertex; b++) if (dualvar[b]! < 0) return false;
    for (let k = 0; k < nedge; k++) {
      const [i, j, wt] = edges[k]!;
      let s = dualvar[i]! + dualvar[j]! - 2 * wt;
      const ib: number[] = [i];
      const jb: number[] = [j];
      while (blossomparent[ib[ib.length - 1]!] !== -1) ib.push(blossomparent[ib[ib.length - 1]!]!);
      while (blossomparent[jb[jb.length - 1]!] !== -1) jb.push(blossomparent[jb[jb.length - 1]!]!);
      ib.reverse();
      jb.reverse();
      for (let x = 0; x < Math.min(ib.length, jb.length); x++) {
        if (ib[x] !== jb[x]) break;
        s += 2 * dualvar[ib[x]!]!;
      }
      if (s < 0) return false;
      if (mate[i]! >> 1 === k || mate[j]! >> 1 === k) {
        if (!(mate[i]! >> 1 === k && mate[j]! >> 1 === k)) return false;
        if (s !== 0) return false;
      }
    }
    for (let v = 0; v < nvertex; v++) if (!(mate[v]! >= 0 || dualvar[v]! + vdualoffset === 0)) return false;
    for (let b = nvertex; b < 2 * nvertex; b++) {
      if (blossombase[b]! >= 0 && dualvar[b]! > 0) {
        const endps = blossomendps[b]!;
        if (endps.length % 2 !== 1) return false;
        for (let x = 1; x < endps.length; x += 2) {
          const p = endps[x]!;
          if (mate[endpoint[p]!] !== (p ^ 1)) return false;
          if (mate[endpoint[p ^ 1]!] !== p) return false;
        }
      }
    }
    return true;
  };

  // Main loop: each iteration is a stage that tries to augment the matching.
  for (let stage = 0; stage < nvertex; stage++) {
    label.fill(0);
    bestedge.fill(-1);
    for (let b = nvertex; b < 2 * nvertex; b++) blossombestedges[b] = null;
    allowedge.fill(0);
    queue = [];
    for (let v = 0; v < nvertex; v++) {
      if (mate[v] === -1 && label[inblossom[v]!] === 0) assignLabel(v, 1, -1);
    }

    let augmented = false;
    for (;;) {
      while (queue.length > 0 && !augmented) {
        const v = queue.pop()!;
        for (let q = nbStart[v]!; q < nbStart[v + 1]!; q++) {
          const p = nbList[q]!;
          const k = p >> 1;
          const w = endpoint[p]!;
          if (inblossom[v] === inblossom[w]) continue;
          let kslack = 0;
          if (!allowedge[k]) {
            kslack = slack(k);
            if (kslack <= 0) allowedge[k] = 1;
          }
          if (allowedge[k]) {
            if (label[inblossom[w]!] === 0) {
              assignLabel(w, 2, p ^ 1);
            } else if (label[inblossom[w]!] === 1) {
              const base = scanBlossom(v, w);
              if (base >= 0) {
                addBlossom(base, k);
              } else {
                augmentMatching(k);
                augmented = true;
                break;
              }
            } else if (label[w] === 0) {
              label[w] = 2;
              labelend[w] = p ^ 1;
            }
          } else if (label[inblossom[w]!] === 1) {
            const b = inblossom[v]!;
            if (bestedge[b] === -1 || kslack < slack(bestedge[b]!)) bestedge[b] = k;
          } else if (label[w] === 0) {
            if (bestedge[w] === -1 || kslack < slack(bestedge[w]!)) bestedge[w] = k;
          }
        }
      }
      if (augmented) break;

      let deltatype = -1;
      let delta = 0;
      let deltaedge = -1;
      let deltablossom = -1;

      if (!maxCardinality) {
        deltatype = 1;
        delta = Infinity;
        for (let v = 0; v < nvertex; v++) delta = Math.min(delta, dualvar[v]!);
      }
      for (let v = 0; v < nvertex; v++) {
        if (label[inblossom[v]!] === 0 && bestedge[v] !== -1) {
          const d = slack(bestedge[v]!);
          if (deltatype === -1 || d < delta) {
            delta = d;
            deltatype = 2;
            deltaedge = bestedge[v]!;
          }
        }
      }
      for (let b = 0; b < 2 * nvertex; b++) {
        if (blossomparent[b] === -1 && label[b] === 1 && bestedge[b] !== -1) {
          const d = slack(bestedge[b]!) / 2;
          if (deltatype === -1 || d < delta) {
            delta = d;
            deltatype = 3;
            deltaedge = bestedge[b]!;
          }
        }
      }
      for (let b = nvertex; b < 2 * nvertex; b++) {
        if (blossombase[b]! >= 0 && blossomparent[b] === -1 && label[b] === 2 && (deltatype === -1 || dualvar[b]! < delta)) {
          delta = dualvar[b]!;
          deltatype = 4;
          deltablossom = b;
        }
      }
      if (deltatype === -1) {
        // No further improvement possible; max-cardinality optimum reached.
        deltatype = 1;
        let mn = Infinity;
        for (let v = 0; v < nvertex; v++) mn = Math.min(mn, dualvar[v]!);
        delta = Math.max(0, mn);
      }

      for (let v = 0; v < nvertex; v++) {
        const lb = label[inblossom[v]!];
        if (lb === 1) dualvar[v] = dualvar[v]! - delta;
        else if (lb === 2) dualvar[v] = dualvar[v]! + delta;
      }
      for (let b = nvertex; b < 2 * nvertex; b++) {
        if (blossombase[b]! >= 0 && blossomparent[b] === -1) {
          if (label[b] === 1) dualvar[b] = dualvar[b]! + delta;
          else if (label[b] === 2) dualvar[b] = dualvar[b]! - delta;
        }
      }

      if (deltatype === 1) break;
      if (deltatype === 2) {
        allowedge[deltaedge] = 1;
        let [i, j] = edges[deltaedge]!;
        if (label[inblossom[i]!] === 0) {
          const tmp = i;
          i = j;
          j = tmp;
        }
        void j;
        queue.push(i);
      } else if (deltatype === 3) {
        allowedge[deltaedge] = 1;
        const [i] = edges[deltaedge]!;
        queue.push(i);
      } else if (deltatype === 4) {
        expandBlossom(deltablossom, false);
      }
    }

    if (!augmented) break;

    for (let b = nvertex; b < 2 * nvertex; b++) {
      if (blossomparent[b] === -1 && blossombase[b]! >= 0 && label[b] === 1 && dualvar[b] === 0) expandBlossom(b, true);
    }
  }

  const certificateVerified = verifyOptimum();

  const result = new Int32Array(nvertex).fill(-1);
  for (let v = 0; v < nvertex; v++) if (mate[v]! >= 0) result[v] = endpoint[mate[v]!]!;
  for (let v = 0; v < nvertex; v++) {
    if (result[v] !== -1 && result[result[v]!] !== v) throw new Error('maxWeightMatching: inconsistent mate array');
  }
  return { mate: result, certificateVerified };
}

/**
 * Minimum-cost perfect matching on the complete graph over k vertices
 * (k even) with symmetric integer cost matrix `cost`.
 */
export function minCostPerfectMatchingComplete(k: number, cost: (i: number, j: number) => number): { mate: Int32Array; total: number; certificateVerified: boolean } {
  if (k === 0) return { mate: new Int32Array(0), total: 0, certificateVerified: true };
  if (k % 2 !== 0) throw new Error('minCostPerfectMatchingComplete: odd number of vertices');
  if (k === 2) return { mate: Int32Array.from([1, 0]), total: cost(0, 1), certificateVerified: true };
  let maxCost = 0;
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) maxCost = Math.max(maxCost, cost(i, j));
  const C = maxCost + 1;
  const edges: WeightedEdgeList = [];
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) edges.push([i, j, C - cost(i, j)]);
  const { mate, certificateVerified } = maxWeightMatching(edges, true);
  let total = 0;
  for (let i = 0; i < k; i++) {
    if (mate[i]! < 0) throw new Error('minCostPerfectMatchingComplete: matching is not perfect');
    if (mate[i]! > i) total += cost(i, mate[i]!);
  }
  return { mate, total, certificateVerified };
}
