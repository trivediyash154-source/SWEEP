import type { DirectedOptimizationRecord, OptimizationRecord, SingleRouteRecord } from '@sweep/engine';
import { formatDistance, formatNumber } from './format';

/**
 * The algorithm investigation is generated from the solver's own record: every
 * step, count and highlighted vertex or street below is read from it, never
 * from a fixed script.
 */
export type StepId = 'network' | 'degrees' | 'odd' | 'paths' | 'matching' | 'augment' | 'euler' | 'verify' | 'balance' | 'imbalanced' | 'flow';

export interface AnalysisStep {
  id: StepId;
  title: string;
  kicker: string;
  summary: string;
}

/** Records stored before directed mode existed carry no `mode`. */
export function normalizeRecord<T extends SingleRouteRecord>(r: T): T {
  if ((r as { mode?: string }).mode) return r;
  const u = r as unknown as OptimizationRecord;
  return {
    ...u,
    mode: 'undirected',
    algorithm: { ...u.algorithm, directionPolicy: u.algorithm.directionPolicy ?? 'two-way' },
    route: { ...u.route, wrongWayTraversals: u.route.wrongWayTraversals ?? 0 },
  } as unknown as T;
}

export function analysisSteps(r: SingleRouteRecord): AnalysisStep[] {
  const passed = r.checks.filter((c) => c.passed).length;
  const verify: AnalysisStep = {
    id: 'verify',
    title: 'Verification',
    kicker: '07',
    summary: `${passed} of ${r.checks.length} independent checks passed. ${r.algorithm.optimal ? 'Optimality is certified.' : 'Optimality is not certified.'}`,
  };
  if (r.mode === 'directed') {
    const d = r as DirectedOptimizationRecord;
    const surplus = d.balance.filter((b) => b.delta > 0);
    const deficit = d.balance.filter((b) => b.delta < 0);
    const units = surplus.reduce((s, b) => s + b.delta, 0);
    return [
      { id: 'network', title: 'Permitted directions', kicker: '00', summary: `${d.input.edgeCount} streets give ${d.input.arcCount} permitted directions of travel; ${d.input.onewayEdgeCount} streets are one-way. ${d.input.requiredArcCount} directions must be serviced.` },
      { id: 'balance', title: 'In- and out-degree', kicker: '01', summary: `A closed route leaves every intersection as often as it enters it. For each intersection SWEEP compares required arrivals with required departures.` },
      {
        id: 'imbalanced',
        title: 'Imbalanced intersections',
        kicker: '02',
        summary: units === 0 ? 'Every intersection is already balanced, so no extra driving is needed.' : `${surplus.length} intersections have surplus arrivals (they need ${units} extra departures in total) and ${deficit.length} have surplus departures.`,
      },
      { id: 'paths', title: 'Shortest legal paths', kicker: '03', summary: `Extra driving must follow permitted directions only. Shortest legal paths connect surplus intersections to deficit intersections (Dijkstra on reduced costs).` },
      {
        id: 'flow',
        title: 'Minimum-cost flow',
        kicker: '04',
        summary:
          units === 0
            ? 'No flow is needed.'
            : `${d.flow.totalUnits} units of flow along ${d.flow.paths.length} paths cost ${formatDistance(d.flow.cost)}. ${d.flow.dualCertificateVerified ? 'Node potentials certify that no cheaper balancing exists (LP duality).' : 'The flow certificate failed.'}`,
      },
      {
        id: 'augment',
        title: 'Balanced multigraph',
        kicker: '05',
        summary: `${Object.values(d.augmentation.addedCopies).reduce((s, c) => s + c, 0)} arc copies (${formatDistance(d.augmentation.addedDistance)}) are added; every intersection is now entered as often as it is left.`,
      },
      { id: 'euler', title: 'Directed Euler circuit', kicker: '06', summary: `Hierholzer's algorithm walks every arc copy exactly once: ${d.route.steps.length} legal traversals, ${formatDistance(d.route.totalDistance)} in total, back at the start.` },
      verify,
    ];
  }
  const u = r as OptimizationRecord;
  const k = u.oddVertexIds.length;
  return [
    { id: 'network', title: 'Original network', kicker: '00', summary: `${u.input.vertexCount} intersections and ${u.input.edgeCount} streets, ${u.input.requiredEdgeCount} required (${formatDistance(u.route.requiredDistance)}).` },
    { id: 'degrees', title: 'Degree analysis', kicker: '01', summary: `Each intersection's degree counts the required streets that meet there. A closed route can traverse every street once only if every degree is even.` },
    { id: 'odd', title: 'Odd-degree intersections', kicker: '02', summary: k === 0 ? 'Every degree is even: the network is already Eulerian, so no street needs repeating.' : `${k} intersections have odd degree. They must be paired, and each pair joined by repeated streets.` },
    {
      id: 'paths',
      title: 'Shortest paths',
      kicker: '03',
      summary: k === 0 ? 'Nothing to pair.' : `Dijkstra gives the shortest path between every pair of odd intersections: ${formatNumber((k * (k - 1)) / 2)} candidate pairings form a complete auxiliary graph.`,
    },
    {
      id: 'matching',
      title: 'Minimum-weight matching',
      kicker: '04',
      summary:
        k === 0
          ? 'No matching is needed.'
          : `Edmonds' blossom algorithm pairs the ${k} odd intersections at total cost ${formatDistance(u.matching.cost)}. ${u.matching.dualCertificateVerified ? 'The LP dual certificate proves no cheaper pairing exists.' : 'The certificate failed.'}${u.matching.optimalPairingCount ? ` ${u.matching.optimalPairingCount} optimal pairing(s) exist.` : ''}`,
    },
    {
      id: 'augment',
      title: 'Graph augmentation',
      kicker: '05',
      summary: `${Object.values(u.augmentation.addedCopies).reduce((s, c) => s + c, 0)} street copies (${formatDistance(u.augmentation.addedDistance)}) are added along the matched paths. ${u.augmentation.allDegreesEven ? 'Every degree is now even.' : ''}`,
    },
    { id: 'euler', title: 'Euler circuit', kicker: '06', summary: `Hierholzer's algorithm traverses every street copy exactly once: ${u.route.steps.length} traversals, ${formatDistance(u.route.totalDistance)}, closed at the start.` },
    verify,
  ];
}

export type VertexMark = 'odd' | 'even' | 'surplus' | 'deficit' | 'matched' | 'focus';
export type EdgeMark = 'path' | 'added' | 'focus';

export interface Highlight {
  vertices: Map<string, VertexMark>;
  edges: Map<string, EdgeMark>;
  /** Labels to draw next to vertices (degrees, deltas). */
  labels: Map<string, string>;
  showRoute: boolean;
  dimBase: boolean;
}

export const EMPTY_HIGHLIGHT: Highlight = { vertices: new Map(), edges: new Map(), labels: new Map(), showRoute: true, dimBase: false };

/**
 * Highlight for the current analysis step. `focus` is an odd/imbalanced vertex
 * picked by the user; `pair` a matched pair or flow path index; `inspectPath`
 * an on-demand shortest path between two picked vertices.
 */
export function highlightFor(
  r: SingleRouteRecord | null,
  step: StepId | null,
  focus: { vertex?: string | null; pair?: number | null; inspectPath?: { vertexIds: string[]; edgeIds: string[] } | null } = {},
): Highlight {
  if (!r || !step) return EMPTY_HIGHLIGHT;
  const vertices = new Map<string, VertexMark>();
  const edges = new Map<string, EdgeMark>();
  const labels = new Map<string, string>();
  let showRoute = false;
  let dimBase = false;
  if (r.mode === 'directed') {
    const d = r as DirectedOptimizationRecord;
    if (step === 'balance' || step === 'imbalanced' || step === 'paths' || step === 'flow') {
      for (const b of d.balance) {
        if (step === 'balance') labels.set(b.vertexId, `${b.inRequired}↘ ${b.outRequired}↗`);
        else if (b.delta !== 0) labels.set(b.vertexId, b.delta > 0 ? `+${b.delta}` : `${b.delta}`);
        if (b.delta > 0) vertices.set(b.vertexId, 'surplus');
        else if (b.delta < 0) vertices.set(b.vertexId, 'deficit');
      }
    }
    if (step === 'flow' || step === 'paths') {
      d.flow.paths.forEach((p, i) => {
        if (focus.pair != null && focus.pair !== i) return;
        for (const e of p.pathEdgeIds) edges.set(e, focus.pair === i ? 'focus' : 'path');
      });
    }
    if (step === 'augment') {
      for (const id of Object.keys(d.augmentation.addedEdgeCopies)) edges.set(id, 'added');
      dimBase = true;
    }
  } else {
    const u = r as OptimizationRecord;
    if (step === 'degrees' || step === 'odd') {
      for (const dg of u.degrees) {
        if (step === 'degrees') labels.set(dg.vertexId, String(dg.requiredDegree));
        vertices.set(dg.vertexId, dg.odd ? 'odd' : step === 'degrees' ? 'even' : 'even');
      }
      if (step === 'odd') for (const id of [...vertices.keys()]) if (vertices.get(id) !== 'odd') vertices.delete(id);
    }
    if (step === 'paths' || step === 'matching') {
      for (const id of u.oddVertexIds) vertices.set(id, 'odd');
      u.matching.pairs.forEach((p, i) => {
        const inFocus = focus.pair === i || (focus.vertex != null && (p.a === focus.vertex || p.b === focus.vertex));
        if (step === 'matching' || inFocus) {
          for (const e of p.pathEdgeIds) edges.set(e, inFocus ? 'focus' : 'path');
          if (inFocus) {
            vertices.set(p.a, 'matched');
            vertices.set(p.b, 'matched');
          }
        }
      });
    }
    if (step === 'augment') {
      for (const id of Object.keys(u.augmentation.addedCopies)) edges.set(id, 'added');
      dimBase = true;
    }
  }
  if (step === 'euler' || step === 'verify' || step === 'network') showRoute = step !== 'network';
  if (focus.vertex) vertices.set(focus.vertex, 'focus');
  if (focus.inspectPath) for (const e of focus.inspectPath.edgeIds) edges.set(e, 'focus');
  return { vertices, edges, labels, showRoute, dimBase };
}
