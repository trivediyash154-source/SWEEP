import { describe, expect, it } from 'vitest';
import { geojsonToGraph, GeoJsonImportError, parseGraphJson, GraphParseError, toCsv, solveChinesePostman, validateGraph, eulerCircuit } from '../src/index.js';

const fc = (features: unknown[]) => ({ type: 'FeatureCollection', features });
const line = (coords: number[][], props: Record<string, unknown> = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });

describe('GeoJSON import', () => {
  it('splits lines at shared points and measures geodesic length', () => {
    // A cross: two lines sharing a middle point at (73.85, 18.52)
    const r = geojsonToGraph(
      fc([
        line([[73.849, 18.52], [73.85, 18.52], [73.851, 18.52]], { name: 'East–West Road' }),
        line([[73.85, 18.519], [73.85, 18.52], [73.85, 18.521]], { name: 'North–South Road', required: false }),
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [73.85, 18.52] } },
      ]),
    );
    expect(r.graph.vertices).toHaveLength(5);
    expect(r.graph.edges).toHaveLength(4);
    expect(r.skippedFeatures).toHaveLength(1);
    // 0.001° of longitude at 18.52°N ≈ 105.5 m
    const ew = r.graph.edges.filter((e) => e.name === 'East–West Road');
    for (const e of ew) expect(e.weight).toBeGreaterThan(104);
    for (const e of ew) expect(e.weight).toBeLessThan(107);
    expect(r.graph.edges.filter((e) => !e.required)).toHaveLength(2);
    expect(validateGraph(r.graph).ok).toBe(true);
    expect(solveChinesePostman(r.graph).ok).toBe(true);
  });
  it('rejects non-street input clearly', () => {
    expect(() => geojsonToGraph(42)).toThrow(GeoJsonImportError);
    expect(() => geojsonToGraph({ type: 'Topology' })).toThrow(/FeatureCollection/);
    expect(() => geojsonToGraph(fc([{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } }]))).toThrow(/No usable/);
    expect(() => geojsonToGraph(fc([line([[200, 0], [0, 0]])]))).toThrow(/No usable/);
  });
  it('keeps one-way streets in the drawing direction (oneway=yes/true/1)', () => {
    for (const oneway of ['yes', true, '1', 'true']) {
      const r = geojsonToGraph(fc([line([[0, 0], [0.0005, 0.0001], [0.001, 0]], { oneway }), line([[0.001, 0], [0.002, 0]])]));
      const [e0, e1] = r.graph.edges;
      expect(e0!.oneway, String(oneway)).toBe(true);
      const geoOf = (id: string) => r.graph.vertices.find((v) => v.id === id)!.geo;
      expect(geoOf(e0!.u)).toEqual([0, 0]);
      expect(geoOf(e0!.v)).toEqual([0.001, 0]);
      expect(e1!.oneway).toBeUndefined();
      expect(r.notes[0]).toMatch(/1 one-way street/);
      expect(r.warnings).toEqual([]);
    }
  });
  it('stores oneway=-1 streets reversed (u/v swapped, shape reversed)', () => {
    for (const oneway of ['-1', -1]) {
      const r = geojsonToGraph(fc([line([[0, 0], [0.0004, 0.0001], [0.0007, 0.0002], [0.001, 0]], { oneway })]));
      const e = r.graph.edges[0]!;
      expect(e.oneway).toBe(true);
      const geoOf = (id: string) => r.graph.vertices.find((v) => v.id === id)!.geo;
      expect(geoOf(e.u)).toEqual([0.001, 0]);
      expect(geoOf(e.v)).toEqual([0, 0]);
      expect(e.shape).toHaveLength(2);
      // the first shape point after u is the one nearest the line's end
      expect(e.shape![0]![0]).toBeGreaterThan(e.shape![1]![0]);
      expect(r.notes[0]).toMatch(/oneway=-1/);
    }
  });
  it('treats oneway=no, false and absent as two-way, and keeps geo and provenance', () => {
    const r = geojsonToGraph(fc([line([[0, 0], [0.001, 0]], { oneway: 'no' }), line([[0.001, 0], [0.002, 0]], { oneway: false }), line([[0.002, 0], [0.003, 0]], { highway: 'residential' })]));
    expect(r.graph.edges.every((e) => e.oneway === undefined)).toBe(true);
    expect(r.notes[0]).toMatch(/No one-way streets/);
    expect(r.graph.vertices.every((v) => Array.isArray(v.geo))).toBe(true);
    expect(r.graph.source?.kind).toBe('imported-file');
    expect(r.graph.source?.notes).toContain(r.notes[0]);
    expect(r.graph.edges[2]!.roadClass).toBe('residential');
  });
  it('warns about unrecognised one-way values and treats them as two-way', () => {
    const r = geojsonToGraph(fc([line([[0, 0], [0.001, 0]], { oneway: 'reversible' })]));
    expect(r.graph.edges[0]!.oneway).toBeUndefined();
    expect(r.warnings[0]).toMatch(/reversible.*two-way/);
  });
});

describe('graph JSON and CSV', () => {
  it('parses only JSON and drops unknown fields', () => {
    const g = parseGraphJson(JSON.stringify({ vertices: [{ id: 'a', x: 0, y: 0, evil: '<script>' }], edges: [], extra: 1 }));
    expect(g.vertices[0]).toEqual({ id: 'a', x: 0, y: 0 });
    expect(() => parseGraphJson('{not json')).toThrow(GraphParseError);
    expect(() => parseGraphJson(JSON.stringify({ format: 'other', vertices: [], edges: [] }))).toThrow(/Unsupported format/);
  });
  it('neutralises spreadsheet formula injection in CSV', () => {
    expect(toCsv([['=HYPERLINK("x")', 'a,b', 'plain']])).toBe(`"'=HYPERLINK(""x"")","a,b",plain\r\n`);
  });
});

describe('Euler circuit', () => {
  it('uses each edge of an Eulerian multigraph exactly once and closes', () => {
    // two triangles sharing vertex 0, plus a loop and a doubled edge
    const ends: Array<[number, number]> = [[0, 1], [1, 2], [2, 0], [0, 3], [3, 4], [4, 0], [2, 2], [3, 4], [3, 4]];
    const c = eulerCircuit(5, ends, 0);
    expect(c.edges.slice().sort((a, b) => a - b)).toEqual(ends.map((_, i) => i));
    expect(c.vertices.at(-1)).toBe(0);
    let at = 0;
    c.edges.forEach((e, i) => {
      const [u, v] = ends[e]!;
      expect(u === at || v === at).toBe(true);
      at = u === at ? v : u;
      expect(at).toBe(c.vertices[i]);
    });
  });
});
