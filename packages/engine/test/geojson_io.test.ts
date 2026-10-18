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
  it('warns about one-way streets', () => {
    const r = geojsonToGraph(fc([line([[0, 0], [0.001, 0]], { oneway: 'yes' })]));
    expect(r.warnings[0]).toMatch(/two-way/);
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
