import type { CityModel } from '../city/types.js';
import { buildCH, chQuery, type ContractionHierarchy } from './ch.js';
import { altHeuristic, buildLandmarks, type Landmarks } from './landmarks.js';
import { buildRoutingGraph, weightsFor, type RoutingGraph, type RoutingGraphOptions } from './network.js';
import type { Objective, ProfileId } from './profiles.js';
import { bestFirst, bidirectional, euclideanHeuristic, toResult, TraceRecorder, type AlgorithmId, type Preprocessing, type RawResult, type RouteQuery, type RouteResult, type SearchTrace } from './search.js';

export const ALGORITHMS: readonly { id: AlgorithmId; label: string; preprocessing: boolean; note: string }[] = [
  { id: 'dijkstra', label: 'Dijkstra', preprocessing: false, note: 'Exact. Settles arcs in order of cost from the origin.' },
  { id: 'astar', label: 'A*', preprocessing: false, note: 'Exact. Goal-directed by a straight-line lower bound at the fastest speed in the network.' },
  { id: 'bidirectional', label: 'Bidirectional Dijkstra', preprocessing: false, note: 'Exact. Searches from both ends; stops when topF + topB ≥ best meeting cost.' },
  { id: 'alt', label: 'ALT (landmarks)', preprocessing: true, note: 'Exact. A* with triangle-inequality bounds from precomputed landmark distances.' },
  { id: 'ch', label: 'Contraction Hierarchies', preprocessing: true, note: 'Exact. Bidirectional upward search on a contracted, turn-expanded graph with shortcuts.' },
];

/**
 * One routing engine per (city, profile, scenario). Holds the edge-based graph
 * and lazily built preprocessing (landmarks, contraction hierarchy) per
 * objective. Every algorithm queries the same graph with the same cost
 * function, so their answers are directly comparable.
 */
export class RoutingEngine {
  readonly graph: RoutingGraph;
  readonly buildMs: number;
  private lm: Partial<Record<Objective, Landmarks>> = {};
  private chs: Partial<Record<Objective, ContractionHierarchy>> = {};

  constructor(city: CityModel, profile: ProfileId, opts: RoutingGraphOptions = {}) {
    const t0 = performance.now();
    this.graph = buildRoutingGraph(city, profile, opts);
    this.buildMs = performance.now() - t0;
  }

  landmarks(objective: Objective, k = 8): Landmarks {
    return (this.lm[objective] ??= buildLandmarks(this.graph, objective, k));
  }

  hierarchy(objective: Objective): ContractionHierarchy {
    return (this.chs[objective] ??= buildCH(this.graph, objective));
  }

  preprocessingStatus(algorithm: AlgorithmId, objective: Objective): Preprocessing {
    if (algorithm === 'alt') {
      const l = this.lm[objective];
      return { required: true, done: !!l, ms: l?.ms ?? 0, bytes: l?.bytes ?? 0, ...(l ? { detail: `${l.k} landmarks` } : {}) };
    }
    if (algorithm === 'ch') {
      const c = this.chs[objective];
      return { required: true, done: !!c, ms: c?.ms ?? 0, bytes: c?.bytes ?? 0, ...(c ? { detail: `${c.shortcuts.toLocaleString('en-US')} shortcuts over ${c.originalEdges.toLocaleString('en-US')} transitions` } : {}) };
    }
    return { required: false, done: true, ms: 0, bytes: 0 };
  }

  private run(algorithm: AlgorithmId, q: RouteQuery, trace?: TraceRecorder): RawResult {
    const g = this.graph;
    const w = weightsFor(g, q.objective);
    switch (algorithm) {
      case 'dijkstra':
        return bestFirst(g, w, q, null, trace);
      case 'astar':
        return bestFirst(g, w, q, euclideanHeuristic(g, q), trace);
      case 'bidirectional':
        return bidirectional(g, w, q, trace);
      case 'alt':
        return bestFirst(g, w, q, altHeuristic(g, this.landmarks(q.objective), q), trace);
      case 'ch':
        return chQuery(g, this.hierarchy(q.objective), q, trace);
    }
  }

  /**
   * Run one query. Preprocessing is built first if needed (and not timed as
   * part of the query). runtimeMs is measured without tracing (median of
   * `repeat` runs); with `trace` the search is run once more to record its
   * real settle order.
   */
  query(algorithm: AlgorithmId, q: RouteQuery, opts: { repeat?: number; trace?: boolean } = {}): { result: RouteResult; trace?: SearchTrace } {
    if (algorithm === 'alt') this.landmarks(q.objective);
    if (algorithm === 'ch') this.hierarchy(q.objective);
    const n = Math.max(1, Math.floor(opts.repeat ?? 1));
    const times: number[] = [];
    let raw: RawResult | null = null;
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      raw = q.origin === q.destination ? { found: true, cost: 0, arcs: [], expanded: 0, edgesScanned: 0 } : this.run(algorithm, q);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const result = toResult(this.graph, algorithm, q, raw!, times[Math.floor(times.length / 2)]!, n, this.preprocessingStatus(algorithm, q.objective));
    if (!opts.trace) return { result };
    const rec = new TraceRecorder();
    if (q.origin !== q.destination) this.run(algorithm, q, rec);
    return { result, trace: rec.finish() };
  }
}
