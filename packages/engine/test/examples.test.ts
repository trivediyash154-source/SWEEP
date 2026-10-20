import { describe, expect, it } from 'vitest';
import { EXAMPLES, getExample, solveChinesePostman, solveRouting, exhaustiveOptimalTotal, validateGraph, heroCityGraph } from './exampleHelpers.js';

const solve = (id: string) => {
  const ex = getExample(id)!;
  const r = solveChinesePostman(ex.graph);
  if (!r.ok) throw new Error(`${id} failed: ${JSON.stringify(r.validation.issues)}`);
  return r;
};

describe('bundled examples', () => {
  it('every solvable example passes all checks and is certified optimal', () => {
    for (const ex of EXAMPLES) {
      // Examples with one-way streets declare directed routing; they are covered by the test below.
      if (ex.graph.routing?.mode === 'directed') continue;
      const r = solveChinesePostman(ex.graph);
      if (ex.id === 'twin-districts') {
        expect(r.ok).toBe(false);
        continue;
      }
      expect(r.ok, ex.id).toBe(true);
      if (!r.ok) continue;
      expect(r.checks.filter((c) => !c.passed), ex.id).toEqual([]);
      expect(r.algorithm.optimal, ex.id).toBe(true);
      if (ex.graph.edges.length <= 18) {
        const exh = exhaustiveOptimalTotal(ex.graph, 1)!;
        expect(r.route.totalDistance, ex.id).toBeCloseTo(exh.total, 9);
      }
    }
  });

  it('Zurich Altstadt (real OSM data) is solved exactly in directed mode, never by the undirected solver', () => {
    const ex = getExample('zurich-altstadt')!;
    expect(ex.graph.source?.kind).toBe('bundled-sample');
    expect(ex.graph.source?.attribution).toContain('OpenStreetMap');
    expect(ex.graph.routing?.mode).toBe('directed');
    const strict = solveChinesePostman(ex.graph);
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.validation.issues.map((i) => i.code)).toContain('ONEWAY_REQUIRES_DIRECTED');
    const r = solveRouting(ex.graph);
    if (!r.ok) throw new Error(JSON.stringify(r.validation.issues.filter((i) => i.severity === 'error')));
    expect(r.single.mode).toBe('directed');
    expect(r.single.checks.filter((c) => !c.passed)).toEqual([]);
    expect(r.single.algorithm.optimal).toBe(true);
    const relaxed = solveRouting(ex.graph, { mode: 'undirected', ignoreOneway: true });
    if (!relaxed.ok) throw new Error('relaxation should solve');
    expect(relaxed.single.route.totalDistance).toBeLessThan(r.single.route.totalDistance);
    expect(relaxed.single.route.wrongWayTraversals).toBeGreaterThan(0);
  });

  it('Königsberg: four odd landmasses, two bridges repeated', () => {
    const r = solve('konigsberg');
    expect(r.oddVertexIds.sort()).toEqual(['K', 'L', 'N', 'S']);
    expect(r.matching.pairs).toHaveLength(2);
    expect(r.route.steps).toHaveLength(9);
  });

  it('Heritage Loop is Eulerian: zero repeated distance', () => {
    const r = solve('heritage-loop');
    expect(r.oddVertexIds).toEqual([]);
    expect(r.route.repeatedDistance).toBe(0);
    expect(r.route.totalDistance).toBe(r.route.requiredDistance);
  });

  it('Riverside Ladder: the middle rung is duplicated', () => {
    const r = solve('riverside-ladder');
    expect(r.oddVertexIds.sort()).toEqual(['b1', 't1']);
    expect(r.matching.pairs[0]!.pathEdgeIds).toEqual(['c1']);
  });

  it('Old Town Grid: eight odd boundary junctions', () => {
    const r = solve('old-town-grid');
    expect(r.oddVertexIds).toHaveLength(8);
    expect(r.matching.crossCheckCost).toBe(r.matching.cost);
  });

  it('Crescent Quay: exact matching beats greedy (80 m vs 140 m)', () => {
    const r = solve('greedy-trap');
    expect(r.augmentation.addedDistance).toBe(80);
    const greedy = r.baselines.find((b) => b.id === 'greedy-pairing')!;
    expect(greedy.total! - r.route.requiredDistance).toBe(140);
  });

  it('Four Corners: two equally optimal pairings are reported', () => {
    const r = solve('four-corners');
    expect(r.matching.optimalPairingCount).toBe(2);
  });

  it('Twin Districts: disconnected required streets are rejected with a connector suggestion', () => {
    const ex = getExample('twin-districts')!;
    const v = validateGraph(ex.graph);
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.code)).toContain('REQUIRED_DISCONNECTED');
    expect(v.connectorSuggestion!.edgeIds).toEqual(['l1', 'l2']);
    const fixed = { ...ex.graph, edges: ex.graph.edges.map((e) => (v.connectorSuggestion!.edgeIds.includes(e.id) ? { ...e, required: true } : e)) };
    const r = solveChinesePostman(fixed);
    expect(r.ok).toBe(true);
  });

  it('Plaza Crossing: the zero-length link pairs the plaza nodes for free', () => {
    const r = solve('plaza-crossing');
    expect(r.matching.cost).toBe(0);
    expect(r.augmentation.addedCopies).toEqual({ z: 1 });
  });

  it('Market Avenues: the duplicated path is an unserviced deadhead', () => {
    const r = solve('market-avenues');
    expect(r.oddVertexIds.sort()).toEqual(['m04', 'm34']);
    expect(r.augmentation.addedDistance).toBe(420);
    expect(r.route.deadheadTraversals).toBe(3);
    expect(r.route.repeatedRequiredTraversals).toBe(0);
  });

  it('Meridian District: hundreds of odd vertices, solved and certified', () => {
    const r = solve('meridian-district');
    expect(r.oddVertexIds.length).toBeGreaterThan(50);
    expect(r.matching.dualCertificateVerified).toBe(true);
  });

  it('hero city is solvable', () => {
    const r = solveChinesePostman(heroCityGraph());
    expect(r.ok).toBe(true);
  });
});
