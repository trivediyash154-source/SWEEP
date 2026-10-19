import { describe, expect, it } from 'vitest';
import {
  buildOverpassQuery,
  bboxAreaKm2,
  DRIVABLE_ROAD_CLASSES,
  haversine,
  normalizeRoadClasses,
  osmToGraph,
  OsmImportError,
  validateBbox,
  type Graph,
  type Point,
} from '../src/index.js';
import { validateGraph } from '../src/validate.js';
import { getExample } from '../src/examples/index.js';
import { ZURICH_ALTSTADT_QUERY, zurichAltstadtOverpass } from '../src/examples/data/zurichAltstadt.js';

// Unit fixtures: hand-made Overpass-shaped JSON with obviously fake ids near (0°, 0°).
// They are test inputs, not map data. 0.001° ≈ 111 m at the equator.
const node = (id: number, lon: number, lat: number) => ({ type: 'node', id, lat, lon });
const way = (id: number, nodes: number[], tags: Record<string, string> = {}) => ({ type: 'way', id, nodes, tags: { highway: 'residential', ...tags } });
const osm = (...elements: unknown[]) => ({ version: 0.6, elements });

/** A plus-shaped crossing: west(1)–centre(2)–east(3) and south(4)–centre(2)–north(5), with a bend node 6 on the east arm. */
const crossNodes = [node(1, 0, 0), node(2, 0.001, 0), node(6, 0.0015, 0.0002), node(3, 0.002, 0), node(4, 0.001, -0.001), node(5, 0.001, 0.001)];

const edge = (g: Graph, id: string) => g.edges.find((e) => e.id === id)!;
const geo = (g: Graph, id: string) => g.vertices.find((v) => v.id === id)!.geo!;

describe('osmToGraph: topology', () => {
  it('splits ways at shared nodes only and measures haversine length', () => {
    const r = osmToGraph(osm(...crossNodes, way(10, [1, 2, 6, 3], { name: 'East Street' }), way(11, [4, 2, 5], { ref: 'R5' })));
    expect(r.graph.vertices.map((v) => v.id).sort()).toEqual(['n1', 'n2', 'n3', 'n4', 'n5']);
    expect(r.graph.edges.map((e) => e.id)).toEqual(['w10-0', 'w10-1', 'w11-0', 'w11-1']);
    const east = edge(r.graph, 'w10-1');
    expect([east.u, east.v]).toEqual(['n2', 'n3']);
    expect(east.shape).toHaveLength(1);
    const expected = haversine([0.001, 0], [0.0015, 0.0002]) + haversine([0.0015, 0.0002], [0.002, 0]);
    expect(east.weight).toBe(Math.round(expected * 10) / 10);
    expect(east.name).toBe('East Street');
    expect(edge(r.graph, 'w11-0').name).toBe('R5');
    expect(east.sourceRef).toBe('osm:way/10');
    expect(east.roadClass).toBe('residential');
    expect(r.graph.edges.every((e) => e.required)).toBe(true);
    expect(geo(r.graph, 'n3')).toEqual([0.002, 0]);
    expect(r.graph.units).toBe('m');
    expect(r.graph.routing).toEqual({ mode: 'undirected', twoWay: 'both' });
    expect(r.stats).toMatchObject({ ways: 2, nodes: 6, vertices: 5, edges: 4, onewayEdges: 0, duplicateSegments: 0, droppedComponents: 0, skippedWays: 0 });
    expect(validateGraph(r.graph).ok).toBe(true);
  });

  it('projects to metres with y pointing south', () => {
    const r = osmToGraph(osm(...crossNodes, way(10, [1, 2, 6, 3]), way(11, [4, 2, 5])));
    const n = r.graph.vertices.find((v) => v.id === 'n5')!;
    const s = r.graph.vertices.find((v) => v.id === 'n4')!;
    expect(s.y - n.y).toBeCloseTo(haversine([0.001, -0.001], [0.001, 0.001]), 0);
  });

  it('makes a node visited twice by one way an intersection', () => {
    // a figure-of-eight: 1 → 2 → 3 → 4 → 2 → 5 visits node 2 twice
    const r = osmToGraph(osm(node(1, 0, 0), node(2, 0.001, 0), node(3, 0.0015, 0.0005), node(4, 0.002, 0), node(5, 0.003, 0), way(7, [1, 2, 3, 4, 2, 5])));
    expect(r.graph.edges.map((e) => [e.u, e.v])).toEqual([
      ['n1', 'n2'],
      ['n2', 'n4'],
      ['n4', 'n2'],
      ['n2', 'n5'],
    ]);
    // the part 2 → 3 → 4 → 2 is a loop at node 2, split at its middle node 4
    expect(r.notes.join(' ')).toMatch(/Split 1 closed loop/);
  });

  it('splits closed ways at their middle node so no self-loops are produced', () => {
    const square = [node(1, 0, 0), node(2, 0.001, 0), node(3, 0.001, 0.001), node(4, 0, 0.001)];
    const r = osmToGraph(osm(...square, way(40, [1, 2, 3, 4, 1])));
    expect(r.graph.edges.map((e) => [e.id, e.u, e.v])).toEqual([
      ['w40-0', 'n1', 'n3'],
      ['w40-1', 'n3', 'n1'],
    ]);
    expect(r.graph.edges.some((e) => e.u === e.v)).toBe(false);
    expect(r.notes.join(' ')).toMatch(/Split 1 closed loop/);
    // a loop hanging off a junction (lollipop)
    const r2 = osmToGraph(osm(...square, node(9, -0.001, 0), way(41, [9, 1]), way(42, [1, 2, 3, 4, 1])));
    expect(r2.graph.edges.some((e) => e.u === e.v)).toBe(false);
    expect(r2.graph.edges).toHaveLength(3);
    expect(validateGraph(r2.graph).issues.map((i) => i.code)).not.toContain('SELF_LOOP');
  });

  it('collapses repeated node references and merges distinct nodes at the same position', () => {
    // nodes 2 and 3 are distinct but coincide; way 51 joins them with a zero-length piece
    const r = osmToGraph(osm(node(1, 0, 0), node(2, 0.001, 0), node(3, 0.001, 0), node(4, 0.002, 0), way(50, [1, 1, 2]), way(51, [2, 3]), way(52, [3, 4, 4])));
    expect(r.graph.edges.map((e) => [e.u, e.v])).toEqual([
      ['n1', 'n2'],
      ['n2', 'n4'],
    ]);
    expect(r.stats.droppedComponents).toBe(0);
    expect(r.notes.join(' ')).toMatch(/1 zero-length segment/);
    expect(r.graph.edges.every((e) => e.weight > 0)).toBe(true);
  });

  it('skips ways with missing node references and reports them', () => {
    const r = osmToGraph(osm(...crossNodes, way(10, [1, 2, 6, 3]), way(12, [2, 99])));
    expect(r.stats.skippedWays).toBe(1);
    expect(r.graph.edges.map((e) => e.id)).toEqual(['w10-0']);
    expect(r.notes.join(' ')).toMatch(/Skipped 1 way referencing nodes missing/);
  });

  it('filters by road class, rejects area=yes and counts the classes found', () => {
    const r = osmToGraph(osm(...crossNodes, way(10, [1, 2, 6, 3]), way(11, [4, 2, 5], { highway: 'footway' }), way(12, [1, 4, 3, 1], { highway: 'pedestrian', area: 'yes' })));
    expect(r.graph.edges.every((e) => e.sourceRef === 'osm:way/10')).toBe(true);
    expect(r.roadClassesFound).toEqual({ residential: 1, footway: 1, pedestrian: 1 });
    expect(r.notes.join(' ')).toMatch(/Ignored 1 way of other road classes: footway \(1\)/);
    expect(r.notes.join(' ')).toMatch(/Rejected 1 way tagged area=yes/);
    const withFoot = osmToGraph(osm(...crossNodes, way(10, [1, 2, 6, 3]), way(11, [4, 2, 5], { highway: 'footway' })), { roadClasses: ['residential', 'footway'] });
    expect(withFoot.graph.edges).toHaveLength(4);
  });
});

describe('osmToGraph: one-way streets', () => {
  const line = [node(1, 0, 0), node(2, 0.0005, 0.0001), node(3, 0.001, 0)];

  it('oneway=yes|true|1 is one-way along the way', () => {
    for (const oneway of ['yes', 'true', '1']) {
      const r = osmToGraph(osm(...line, way(1, [1, 2, 3], { oneway })));
      const e = r.graph.edges[0]!;
      expect([e.u, e.v, e.oneway], oneway).toEqual(['n1', 'n3', true]);
      expect(r.stats.onewayEdges).toBe(1);
      expect(r.graph.routing?.mode).toBe('directed');
    }
  });

  it('oneway=-1 is stored reversed: u and v swapped, shape reversed', () => {
    const r = osmToGraph(osm(node(1, 0, 0), node(2, 0.0003, 0.0001), node(4, 0.0007, 0.0002), node(3, 0.001, 0), way(1, [1, 2, 4, 3], { oneway: '-1' })));
    const e = r.graph.edges[0]!;
    expect([e.u, e.v, e.oneway]).toEqual(['n3', 'n1', true]);
    expect(e.shape).toHaveLength(2);
    expect(e.shape![0]![0]).toBeGreaterThan(e.shape![1]![0]);
    expect(e.id).toBe('w1-0');
  });

  it('roundabouts and motorways are one-way by implication unless oneway=no', () => {
    const tri = [node(1, 0, 0), node(2, 0.001, 0), node(3, 0.0005, 0.001), node(4, -0.001, 0)];
    const ra = osmToGraph(osm(...tri, way(1, [1, 2, 3, 1], { junction: 'roundabout' }), way(2, [4, 1])));
    expect(ra.graph.edges.filter((e) => e.sourceRef === 'osm:way/1').every((e) => e.oneway)).toBe(true);
    expect(ra.graph.edges.find((e) => e.sourceRef === 'osm:way/2')!.oneway).toBeUndefined();
    expect(ra.notes.join(' ')).toMatch(/one-way by implication/);
    const circ = osmToGraph(osm(...tri, way(1, [1, 2, 3, 1], { junction: 'circular' }), way(2, [4, 1])));
    expect(circ.stats.onewayEdges).toBe(2);
    const no = osmToGraph(osm(...tri, way(1, [1, 2, 3, 1], { junction: 'roundabout', oneway: 'no' }), way(2, [4, 1])));
    expect(no.stats.onewayEdges).toBe(0);
    expect(no.graph.routing?.mode).toBe('undirected');
    const mw = osmToGraph(osm(...line, way(1, [1, 2, 3], { highway: 'motorway' })), { roadClasses: ['motorway'] });
    expect(mw.graph.edges[0]!.oneway).toBe(true);
  });

  it('reversible and unknown oneway values are two-way with a note', () => {
    const r = osmToGraph(osm(...line, way(1, [1, 2], { oneway: 'reversible' }), way(2, [2, 3], { oneway: 'sometimes' })));
    expect(r.stats.onewayEdges).toBe(0);
    expect(r.notes.join(' ')).toMatch(/reversible\/alternating/);
    expect(r.notes.join(' ')).toMatch(/"sometimes" \(1\)/);
  });

  it('reports one-way streets that leave the network (not strongly connected)', () => {
    // a two-way spine 1–2–3 with a one-way exit 3 → 4
    const r = osmToGraph(osm(node(1, 0, 0), node(2, 0.001, 0), node(3, 0.002, 0), node(4, 0.003, 0), way(1, [1, 2, 3]), way(2, [3, 4], { oneway: 'yes' })));
    expect(r.notes.join(' ')).toMatch(/1 street segment \(1 intersection\) cannot be driven as part of a closed route/);
  });
});

describe('osmToGraph: duplicates, components, limits, determinism', () => {
  const pair = [node(1, 0, 0), node(2, 0.001, 0)];

  it('removes duplicate segments (same or reversed node sequence), keeping the lower way id', () => {
    const r = osmToGraph(osm(...pair, way(21, [2, 1]), way(20, [1, 2])));
    expect(r.graph.edges.map((e) => e.id)).toEqual(['w20-0']);
    expect(r.stats.duplicateSegments).toBe(1);
    expect(r.notes.join(' ')).toMatch(/Removed 1 duplicate segment/);
  });

  it('prefers the one-way duplicate, and merges opposite one-way duplicates into a two-way street', () => {
    const a = osmToGraph(osm(...pair, way(30, [1, 2]), way(31, [1, 2], { oneway: 'yes' })));
    expect(a.graph.edges.map((e) => [e.id, e.oneway])).toEqual([['w31-0', true]]);
    const b = osmToGraph(osm(...pair, way(30, [1, 2], { oneway: 'yes' }), way(31, [2, 1], { oneway: 'yes' })));
    expect(b.graph.edges.map((e) => [e.id, e.oneway])).toEqual([['w30-0', undefined]]);
    expect(b.notes.join(' ')).toMatch(/opposite one-way ways/);
    const c = osmToGraph(osm(...pair, way(30, [1, 2], { oneway: 'yes' }), way(31, [2, 1], { oneway: '-1' })));
    expect(c.graph.edges.map((e) => [e.id, e.oneway])).toEqual([['w30-0', true]]);
  });

  it('keeps only the largest connected component by default', () => {
    const els = [node(1, 0, 0), node(2, 0.002, 0), node(3, 0, 0.01), node(4, 0.0005, 0.01), way(1, [1, 2]), way(2, [3, 4])];
    const r = osmToGraph(osm(...els));
    expect(r.graph.edges.map((e) => e.id)).toEqual(['w1-0']);
    expect(r.stats.droppedComponents).toBe(1);
    expect(r.stats.droppedLength).toBe(Math.round(haversine([0, 0.01], [0.0005, 0.01]) * 10) / 10);
    expect(r.notes.join(' ')).toMatch(/Dropped 1 disconnected piece/);
    const all = osmToGraph(osm(...els), { keepAllComponents: true });
    expect(all.graph.edges).toHaveLength(2);
    expect(all.stats.droppedComponents).toBe(0);
    expect(all.notes.join(' ')).toMatch(/2 disconnected parts; all were kept/);
  });

  it('throws clear errors for bad input, no roads and limits', () => {
    expect(() => osmToGraph(42)).toThrow(OsmImportError);
    expect(() => osmToGraph({ type: 'FeatureCollection', features: [] })).toThrow(/Overpass API JSON/);
    try {
      osmToGraph(osm(...pair, way(1, [1, 2], { highway: 'footway' })));
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OsmImportError);
      expect((err as OsmImportError).code).toBe('NO_ROADS');
      expect((err as Error).message).toMatch(/footway \(1\)/);
    }
    expect(() => osmToGraph(osm())).toThrow(/No usable streets/);
    const three = [node(1, 0, 0), node(2, 0.001, 0), node(3, 0.002, 0), way(1, [1, 2]), way(2, [2, 3])];
    expect(() => osmToGraph(osm(...three), { limits: { maxWays: 1 } })).toThrow(/limit is 1/);
    expect(() => osmToGraph(osm(...three), { limits: { maxVertices: 2 } })).toThrow(/intersections; the limit is 2/);
    expect(() => osmToGraph(osm(...three), { limits: { maxEdges: 1 } })).toThrow(/street segments; the limit is 1/);
  });

  it('is deterministic regardless of element order', () => {
    const els = [...crossNodes, way(11, [4, 2, 5], { oneway: '-1' }), way(10, [1, 2, 6, 3], { name: 'East Street' }), way(12, [1, 4])];
    const a = JSON.stringify(osmToGraph(osm(...els)).graph);
    const b = JSON.stringify(osmToGraph(osm(...[...els].reverse())).graph);
    const shuffled = [els[3], els[7], els[0], els[6], els[2], els[8], els[1], els[5], els[4]];
    expect(b).toBe(a);
    expect(JSON.stringify(osmToGraph(osm(...shuffled)).graph)).toBe(a);
  });

  it('stores provenance with attribution and notes', () => {
    const r = osmToGraph(osm(...pair, way(1, [1, 2])), { name: 'Test', source: { kind: 'live-acquisition', provider: 'P', endpoint: 'https://example.invalid/api', notes: ['first'] } });
    expect(r.graph.name).toBe('Test');
    expect(r.graph.source).toMatchObject({ kind: 'live-acquisition', provider: 'P', attribution: '© OpenStreetMap contributors', license: 'ODbL 1.0' });
    expect(r.graph.source!.notes![0]).toBe('first');
    expect(r.graph.source!.notes!.slice(1)).toEqual(r.notes);
    expect(r.graph.source!.roadClasses).toEqual([...DRIVABLE_ROAD_CLASSES]);
    expect(r.graph.description).toMatch(/© OpenStreetMap contributors/);
  });
});

describe('Overpass query and bbox validation', () => {
  it('builds the documented query from whitelisted road classes', () => {
    expect(buildOverpassQuery([47.37, 8.54, 47.3735, 8.5455], ['residential', 'service'])).toBe(
      '[out:json][timeout:25];way["highway"~"^(residential|service)$"](47.37,8.54,47.3735,8.5455);(._;>;);out body;',
    );
    // the bundled sample's query, up to trailing zeros in the coordinates
    const q = buildOverpassQuery([47.37, 8.54, 47.3735, 8.5455], ['residential', 'tertiary', 'secondary', 'primary', 'unclassified', 'living_street', 'service', 'pedestrian']);
    expect(q).toBe(ZURICH_ALTSTADT_QUERY.replace('47.3700,8.5400', '47.37,8.54'));
    expect(buildOverpassQuery([-33.9, 18.4, -33.89, 18.41])).toContain('primary|primary_link');
    expect(buildOverpassQuery([-0.00000001, 0, 0.001, 0.001], ['service'])).toContain('(0,0,0.001,0.001)');
  });

  it('rejects anything outside the whitelist (no query injection)', () => {
    expect(() => buildOverpassQuery([0, 0, 0.01, 0.01], ['residential)$"];node(1);out;//'])).toThrow(OsmImportError);
    expect(() => buildOverpassQuery([0, 0, 0.01, 0.01], ['motorway2'])).toThrow(/Unknown road class/);
    expect(() => buildOverpassQuery([0, 0, 0.01, 0.01], [])).toThrow(/at least one/);
    expect(() => buildOverpassQuery([0.01, 0, 0, 0.01], ['service'])).toThrow(/South/);
    expect(() => buildOverpassQuery([0, 0, 0.01, 0.01], ['service'], 0)).toThrow(/timeout/);
    expect(normalizeRoadClasses(['service', 'primary', 'service'])).toEqual(['primary', 'service']);
  });

  it('validates bounding boxes with readable messages', () => {
    expect(validateBbox([47.37, 8.54, 47.3735, 8.5455])).toEqual([]);
    expect(validateBbox([47.3735, 8.54, 47.37, 8.5455])[0]).toMatch(/South \(47.3735\) must be less than north/);
    expect(validateBbox([47.37, 8.5455, 47.3735, 8.54])[0]).toMatch(/West .* must be less than east/);
    expect(validateBbox([95, 8, 96, 9]).join(' ')).toMatch(/between −90 and 90/);
    expect(validateBbox([0, 179, 1, 181]).join(' ')).toMatch(/between −180 and 180/);
    expect(validateBbox([47.32, 8.45, 47.43, 8.62])[0]).toMatch(/the limit is 4 km²/);
    expect(validateBbox([47.32, 8.45, 47.43, 8.62], 500)).toEqual([]);
    expect(validateBbox([47.37, 8.54, 47.3701, 8.5401])[0]).toMatch(/too small/);
    expect(validateBbox('47,8,48,9')[0]).toMatch(/four numbers/);
    expect(validateBbox([1, 2, 3])[0]).toMatch(/four numbers/);
    expect(validateBbox([0, 0, Number.NaN, 1])[0]).toMatch(/four numbers/);
  });

  it('computes spherical bbox areas', () => {
    // a 1° × 1° cell at the equator is about 12,364 km²
    expect(bboxAreaKm2([0, 0, 1, 1])).toBeCloseTo(12364, -1);
    expect(bboxAreaKm2([47.37, 8.54, 47.3735, 8.5455])).toBeCloseTo(0.161, 2);
    expect(bboxAreaKm2([1, 0, 0, 1])).toBe(0);
  });
});

describe('real sample: Zurich Altstadt (OpenStreetMap, overpass.osm.ch, 2026-10-18)', () => {
  const classes = ['residential', 'tertiary', 'secondary', 'primary', 'unclassified', 'living_street', 'service', 'pedestrian'];
  const r = osmToGraph(zurichAltstadtOverpass, { roadClasses: classes });
  const g = r.graph;
  const nodeCoord = new Map<number, Point>();
  const wayNodes = new Map<number, number[]>();
  for (const el of zurichAltstadtOverpass.elements) {
    if (el.type === 'node') nodeCoord.set(el.id, [el.lon!, el.lat!]);
    else if (el.type === 'way') wayNodes.set(el.id, el.nodes!);
  }

  it('the bundled sample keeps the full response', () => {
    expect(zurichAltstadtOverpass.elements.filter((e) => e.type === 'way')).toHaveLength(144);
    expect(zurichAltstadtOverpass.elements.filter((e) => e.type === 'node')).toHaveLength(831);
    expect(zurichAltstadtOverpass.osm3s?.copyright).toMatch(/ODbL/);
  });

  it('converts into a real, connected street network', () => {
    expect(r.stats.vertices).toBeGreaterThan(100);
    expect(r.stats.edges).toBeGreaterThan(100);
    expect(r.stats.ways).toBeGreaterThan(100);
    expect(r.stats.totalLength).toBeGreaterThan(3000);
    expect(r.stats.onewayEdges).toBeGreaterThan(0);
    expect(r.stats.skippedWays).toBe(0);
    expect(g.routing?.mode).toBe('directed');
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length);
    expect(g.edges.every((e) => e.u !== e.v && /^w\d+-\d+$/.test(e.id) && /^osm:way\/\d+$/.test(e.sourceRef!))).toBe(true);
  });

  it('every vertex carries its OSM position', () => {
    for (const v of g.vertices) {
      expect(v.geo, v.id).toEqual(nodeCoord.get(Number(v.id.slice(1))));
      const [lon, lat] = v.geo!;
      expect(lat).toBeGreaterThan(47.36);
      expect(lat).toBeLessThan(47.38);
      expect(lon).toBeGreaterThan(8.53);
      expect(lon).toBeLessThan(8.55);
    }
  });

  it('edge weights equal the haversine length of the mapped nodes', () => {
    let checked = 0;
    for (const e of g.edges) {
      const nodes = wayNodes.get(Number(e.sourceRef!.split('/')[1]))!;
      const u = Number(e.u.slice(1));
      const v = Number(e.v.slice(1));
      const interior = e.shape?.length ?? 0;
      // find the run of the way from u to v (or v to u for reversed one-ways) with the right number of interior nodes
      let run: number[] | null = null;
      for (let i = 0; i < nodes.length && !run; i++) {
        const j = i + interior + 1;
        if (nodes[i] === u && nodes[j] === v) run = nodes.slice(i, j + 1);
        else if (nodes[i] === v && nodes[j] === u) run = nodes.slice(i, j + 1).reverse();
      }
      expect(run, e.id).not.toBeNull();
      let len = 0;
      for (let i = 1; i < run!.length; i++) len += haversine(nodeCoord.get(run![i - 1]!)!, nodeCoord.get(run![i]!)!);
      expect(e.weight, e.id).toBe(Math.round(len * 10) / 10);
      checked++;
    }
    expect(checked).toBe(g.edges.length);
  });

  it('is structurally valid (one-way flags stripped)', () => {
    const stripped: Graph = { ...g, edges: g.edges.map(({ oneway: _oneway, ...e }) => e) };
    const v = validateGraph(stripped);
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('is registered as a real-data example with provenance and a two-way depot', () => {
    const ex = getExample('zurich-altstadt')!;
    expect(ex.category).toBe('real-data');
    expect(ex.graph.source).toMatchObject({
      kind: 'bundled-sample',
      endpoint: 'https://overpass.osm.ch/api/interpreter',
      retrievedAt: '2026-10-18T23:23:00Z',
      bbox: [47.37, 8.54, 47.3735, 8.5455],
      attribution: '© OpenStreetMap contributors',
      license: 'ODbL 1.0',
    });
    expect(ex.graph.edges).toHaveLength(g.edges.length);
    const depot = ex.graph.depotId!;
    const touching = ex.graph.edges.filter((e) => e.u === depot || e.v === depot);
    expect(touching.length).toBeGreaterThanOrEqual(2);
    expect(touching.every((e) => !e.oneway)).toBe(true);
  });
});
