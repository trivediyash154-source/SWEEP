import { describe, expect, it } from 'vitest';
import { validateGraph, solveChinesePostman, type Graph } from '../src/index.js';

const base = (): Graph => ({
  vertices: [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 10, y: 0 },
    { id: 'c', x: 10, y: 10 },
  ],
  edges: [
    { id: 'ab', u: 'a', v: 'b', weight: 10, required: true },
    { id: 'bc', u: 'b', v: 'c', weight: 10, required: true },
    { id: 'ca', u: 'c', v: 'a', weight: 14, required: true },
  ],
});
const codes = (g: Graph, depotId?: string) => validateGraph(g, depotId ? { depotId } : {}).issues.map((i) => i.code);

describe('validation', () => {
  it('accepts a valid triangle', () => {
    expect(validateGraph(base()).ok).toBe(true);
  });
  it('rejects empty graphs and graphs without required streets', () => {
    expect(codes({ vertices: [], edges: [] })).toContain('EMPTY_GRAPH');
    const g = base();
    g.edges.forEach((e) => (e.required = false));
    expect(codes(g)).toContain('NO_REQUIRED_EDGES');
  });
  it('rejects duplicate ids, missing endpoints and bad ids', () => {
    const g = base();
    g.vertices.push({ id: 'a', x: 1, y: 1 });
    expect(codes(g)).toContain('DUPLICATE_VERTEX_ID');
    const h = base();
    h.edges.push({ id: 'ab', u: 'a', v: 'zz', weight: 1, required: true });
    expect(codes(h)).toEqual(expect.arrayContaining(['DUPLICATE_EDGE_ID', 'MISSING_ENDPOINT']));
    const i = base();
    i.vertices[0]!.id = 'bad id with spaces';
    expect(codes(i)).toContain('INVALID_ID');
  });
  it('rejects invalid weights and coordinates', () => {
    for (const w of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2e6, '5' as unknown as number]) {
      const g = base();
      g.edges[0]!.weight = w;
      expect(codes(g)).toContain('INVALID_WEIGHT');
    }
    const g = base();
    g.vertices[1]!.x = Number.NaN;
    expect(codes(g)).toContain('INVALID_COORDINATE');
  });
  it('refuses one-way streets in the undirected solver (legacy `directed` spelling included) and points to Directed mode', () => {
    for (const field of ['directed', 'oneway'] as const) {
      const g = base();
      g.edges[0]![field] = true;
      const v = validateGraph(g);
      expect(v.ok).toBe(false);
      expect(v.issues.find((i) => i.code === 'ONEWAY_REQUIRES_DIRECTED')?.message).toMatch(/undirected solver cannot respect one-way.*Directed mode/);
      // An explicit two-way relaxation downgrades it to a warning; the directed solver only notes it.
      expect(validateGraph(g, { onewayPolicy: 'ignore' }).issues.find((i) => i.code === 'ONEWAY_IGNORED')?.severity).toBe('warning');
      expect(validateGraph(g, { onewayPolicy: 'directed' }).issues.find((i) => i.code === 'ONEWAY_PRESENT')?.severity).toBe('info');
    }
  });
  it('reports loops, parallel edges, zero weights and isolated vertices without failing', () => {
    const g = base();
    g.vertices.push({ id: 'lonely', x: 50, y: 50 });
    g.edges.push({ id: 'loop', u: 'a', v: 'a', weight: 5, required: true });
    g.edges.push({ id: 'ab2', u: 'a', v: 'b', weight: 0, required: true });
    const v = validateGraph(g);
    expect(v.ok).toBe(true);
    expect(v.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['SELF_LOOP', 'PARALLEL_EDGES', 'ZERO_WEIGHT', 'ISOLATED_VERTEX']));
    const r = solveChinesePostman(g);
    expect(r.ok && r.checks.every((c) => c.passed)).toBe(true);
  });
  it('distinguishes unreachable from merely disconnected required streets', () => {
    const g = base();
    g.vertices.push({ id: 'x', x: 100, y: 100 }, { id: 'y', x: 110, y: 100 });
    g.edges.push({ id: 'xy', u: 'x', v: 'y', weight: 10, required: true });
    expect(codes(g)).toContain('REQUIRED_UNREACHABLE');
    g.edges.push({ id: 'cx', u: 'c', v: 'x', weight: 90, required: false });
    const v = validateGraph(g);
    expect(v.issues.map((i) => i.code)).toContain('REQUIRED_DISCONNECTED');
    expect(v.connectorSuggestion?.edgeIds).toEqual(['cx']);
  });
  it('validates the depot', () => {
    expect(codes(base(), 'nope')).toContain('DEPOT_UNKNOWN');
    const g = base();
    g.vertices.push({ id: 'd', x: 20, y: 20 });
    g.edges.push({ id: 'cd', u: 'c', v: 'd', weight: 5, required: false });
    expect(codes(g, 'd')).toContain('DEPOT_NOT_ON_REQUIRED');
    const r = solveChinesePostman(base(), { depotId: 'b' });
    expect(r.ok && r.route.steps[0]!.from === 'b' && r.route.steps.at(-1)!.to === 'b').toBe(true);
  });
  it('enforces workload limits', () => {
    expect(validateGraph(base(), { limits: { maxVertices: 2 } }).issues[0]!.code).toBe('LIMIT_EXCEEDED');
    const r = solveChinesePostman(base(), { limits: { maxOddVertices: 0 } });
    // a triangle has no odd vertices, so the odd limit is not hit
    expect(r.ok).toBe(true);
  });
});
