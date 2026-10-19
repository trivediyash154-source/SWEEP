import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCityBundle, buildingHeight, cleanRing, decodeCityBundle, estimateLevels, mergeElements, parseHeight, parseLevels, CityFormatError, type OsmElement } from '../src/index.js';
import { haversine } from '../src/geo.js';

// Small hand-made Overpass fixtures (test data, not map data).
const lat0 = 18.46;
const lon0 = 73.86;
const d = 0.001; // ≈ 105 m east-west, 111 m north-south
const node = (id: number, x: number, y: number): OsmElement => ({ type: 'node', id, lat: lat0 + y * d, lon: lon0 + x * d });
const way = (id: number, nodes: number[], tags: Record<string, string>): OsmElement => ({ type: 'way', id, nodes, tags });
const bld = (id: number, ring: [number, number][], tags: Record<string, string> = { building: 'yes' }): OsmElement => ({
  type: 'way',
  id,
  tags,
  geometry: ring.map(([x, y]) => ({ lat: lat0 + y * d, lon: lon0 + x * d })),
});
const square = (x: number, y: number, s: number): [number, number][] => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];

function fixture() {
  const streets: OsmElement[] = [
    node(1, 0, 0),
    node(2, 1, 0),
    node(3, 2, 0),
    node(4, 1, 1),
    way(100, [1, 2], { highway: 'residential', name: 'Main Street', maxspeed: '30' }),
    way(101, [2, 4], { highway: 'tertiary', oneway: 'yes', access: 'destination' }),
    way(102, [2, 3], { highway: 'residential', name: 'Main Street' }),
  ];
  const buildings: OsmElement[] = [
    bld(500, square(0.2, 0.2, 0.1), { building: 'yes', height: '24 m' }),
    bld(501, square(0.5, 0.2, 0.1), { building: 'apartments', 'building:levels': '7' }),
    bld(502, square(1.2, 0.2, 0.05), { building: 'shed' }),
    bld(503, square(1.5, 0.2, 0.2)), // untyped, area band estimate
    bld(504, [
      [0, 0.5],
      [0.1, 0.6],
      [0.1, 0.5],
      [0, 0.6],
      [0, 0.5],
    ]), // bow-tie: self-intersecting
    bld(505, [
      [0, 0.8],
      [0.1, 0.8],
      [0, 0.8],
    ]), // too few points
    bld(506, square(9, 9, 0.1)), // outside the region
  ];
  const restrictions: OsmElement[] = [
    {
      type: 'relation',
      id: 900,
      tags: { type: 'restriction', restriction: 'no_left_turn' },
      members: [
        { type: 'way', ref: 100, role: 'from' },
        { type: 'node', ref: 2, role: 'via' },
        { type: 'way', ref: 101, role: 'to' },
      ],
    },
    {
      type: 'relation',
      id: 902,
      tags: { type: 'restriction', restriction: 'no_right_turn' },
      members: [
        { type: 'way', ref: 999, role: 'from' },
        { type: 'node', ref: 2, role: 'via' },
        { type: 'way', ref: 101, role: 'to' },
      ],
    },
    {
      type: 'relation',
      id: 901,
      tags: { type: 'restriction', restriction: 'no_u_turn' },
      members: [
        { type: 'way', ref: 100, role: 'from' },
        { type: 'way', ref: 101, role: 'via' },
        { type: 'way', ref: 100, role: 'to' },
      ],
    },
  ];
  return buildCityBundle({
    id: 'fixture',
    name: 'Fixture',
    description: 'test',
    bbox: [lat0 - 0.0005, lon0 - 0.0005, lat0 + 2 * d, lon0 + 2.5 * d],
    roadClasses: ['residential', 'tertiary'],
    streets,
    buildings,
    restrictions,
    provenance: {
      endpoints: ['https://example.invalid/api/interpreter'],
      osmBase: ['2026-10-19T00:00:00Z', '2026-10-19T00:00:00Z'],
      fetched: ['2026-10-19T00:00:00Z', '2026-10-19T00:00:00Z'],
      tiles: { total: 3, ok: 2, missing: ['t0_1 buildings'] },
      queries: { streets: 'q', buildings: 'q' },
    },
    builtAt: '2026-10-19T00:00:00Z',
  });
}

describe('building heights', () => {
  it('parses height values, rejecting implausible ones', () => {
    expect(parseHeight('12')).toBe(12);
    expect(parseHeight('12.5 m')).toBe(12.5);
    expect(parseHeight('40 ft')).toBeCloseTo(12.2, 1);
    expect(parseHeight('1')).toBeNull();
    expect(parseHeight('tall')).toBeNull();
    expect(parseHeight('9000')).toBeNull();
    expect(parseLevels('7')).toBe(7);
    expect(parseLevels('0')).toBeNull();
    expect(parseLevels('3;4')).toBeNull();
  });
  it('labels where every height comes from: tag, levels, or estimate', () => {
    expect(buildingHeight({ height: '24', 'building:levels': '9' }, 100)).toEqual({ height: 24, source: 'height', levels: 9 });
    expect(buildingHeight({ 'building:levels': '7' }, 100)).toEqual({ height: 21, source: 'levels', levels: 7 });
    expect(buildingHeight({ 'building:levels': '4', 'roof:levels': '1' }, 100).height).toBe(15);
    const est = buildingHeight({ building: 'yes' }, 100);
    expect(est.source).toBe('estimate');
    expect(est.levels).toBeNull();
    expect(estimateLevels('shed', 5000)).toBe(1);
    expect(estimateLevels('yes', 30)).toBe(1);
    expect(estimateLevels('yes', 300)).toBe(3);
    expect(estimateLevels(undefined, 5000)).toBe(5);
  });
});

describe('footprint validation', () => {
  it('cleans, orients and rejects rings with stated reasons', () => {
    const ok = cleanRing([
      [0, 0],
      [0, 10],
      [10, 10],
      [10, 10],
      [10, 0],
      [0, 0],
    ]);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.ring).toHaveLength(4);
      expect(ok.area).toBeCloseTo(100);
    }
    expect(cleanRing([[0, 0], [1, 0], [0, 0]]).ok).toBe(false);
    const open = cleanRing([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(open.ok === false && open.problem).toBe('not-closed');
    const bow = cleanRing([[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]]);
    expect(bow.ok === false && bow.problem).toBe('self-intersecting');
    const flat = cleanRing([[0, 0], [5, 0], [10, 0], [0, 0]]);
    expect(flat.ok === false && flat.problem).toBe('zero-area');
  });
});

describe('city bundle', () => {
  it('converts streets into segments that keep OSM attributes and one-way direction', () => {
    const { bundle } = fixture();
    const net = bundle.network;
    expect(bundle.format).toBe('sweep-city/1');
    expect(net.segU.length).toBe(3);
    const ways = net.ways.map((w) => w.id).sort();
    expect(ways).toEqual([100, 101, 102]);
    const main = net.ways.find((w) => w.id === 100)!;
    expect(main).toMatchObject({ highway: 'residential', name: 'Main Street', maxspeed: '30' });
    const side = net.ways.find((w) => w.id === 101)!;
    expect(side).toMatchObject({ highway: 'tertiary', oneway: 'yes', access: 'destination' });
    const sideSeg = net.segWay.findIndex((wi) => net.ways[wi]!.id === 101);
    expect(net.segOneway[sideSeg]).toBe(1);
    expect(net.nodeOsm[net.segU[sideSeg]!]).toBe(2);
    expect(net.nodeOsm[net.segV[sideSeg]!]).toBe(4);
  });
  it('maps via-node turn restrictions onto segments and counts unsupported ones', () => {
    const { bundle } = fixture();
    const r = bundle.network.restrictions;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ osmId: 900, kind: 'no', value: 'no_left_turn' });
    expect(bundle.network.nodeOsm[r[0]!.via]).toBe(2);
    expect(bundle.network.ways[bundle.network.segWay[r[0]!.fromSeg]!]!.id).toBe(100);
    expect(bundle.network.ways[bundle.network.segWay[r[0]!.toSeg]!]!.id).toBe(101);
    expect(bundle.stats.restrictions).toEqual({ mapped: 1, unsupported: 2 });
    expect(bundle.provenance.transformations.join(' ')).toMatch(/via-way restriction: 1/);
  });
  it('keeps valid footprints inside the region with their height source, and reports the rest', () => {
    const { bundle } = fixture();
    const b = bundle.buildings;
    expect(b.osm).toEqual([500, 501, 502, 503]);
    expect(b.heightDm).toEqual([240, 210, 30, 120]); // 503: ≈ 466 m² → 4 estimated levels
    expect(b.heightSrc.map((i) => ['height', 'levels', 'estimate'][i])).toEqual(['height', 'levels', 'estimate', 'estimate']);
    expect(b.levels).toEqual([-1, 7, -1, -1]);
    expect(bundle.stats.buildings.bySource).toEqual({ height: 1, levels: 1, estimate: 2 });
    expect(bundle.stats.buildings.invalid).toEqual({ 'self-intersecting': 1, 'too-few-points': 1 });
    expect(bundle.stats.buildings.outsideRegion).toBe(1);
    expect(bundle.provenance.estimates.join(' ')).toMatch(/ESTIMATED for visual context only/);
    expect(bundle.provenance.limitations.join(' ')).toMatch(/1 tile\(s\) could not be downloaded/);
    expect(bundle.provenance.attribution).toBe('© OpenStreetMap contributors');
  });
  it('round-trips through the decoder with consistent geometry', () => {
    const { bundle } = fixture();
    const c = decodeCityBundle(JSON.parse(JSON.stringify(bundle)));
    expect(c.segCount).toBe(3);
    expect(c.buildingCount).toBe(4);
    for (let s = 0; s < c.segCount; s++) {
      const a = c.segPtOff[s]!;
      const z = c.segPtOff[s + 1]! - 1;
      expect(c.segXY[2 * a]).toBeCloseTo(c.nodeX[c.segU[s]!]!, 6);
      expect(c.segXY[2 * z + 1]).toBeCloseTo(c.nodeY[c.segV[s]!]!, 6);
      const geo = haversine([c.nodeLon[c.segU[s]!]!, c.nodeLat[c.segU[s]!]!], [c.nodeLon[c.segV[s]!]!, c.nodeLat[c.segV[s]!]!]);
      expect(c.segLen[s]).toBeGreaterThanOrEqual(geo - 0.2);
    }
    expect(() => decodeCityBundle({ format: 'nope' })).toThrow(CityFormatError);
    const broken = JSON.parse(JSON.stringify(bundle));
    broken.network.segU[0] = 999;
    expect(() => decodeCityBundle(broken)).toThrow(/missing node/);
  });
  it('merges tile responses without duplicating features', () => {
    const a: OsmElement[] = [node(1, 0, 0), way(7, [1], { highway: 'residential' })];
    const b: OsmElement[] = [node(1, 0, 0), node(2, 1, 1)];
    const m = mergeElements([a, b]);
    expect(m.elements).toHaveLength(3);
    expect(m.duplicates).toBe(1);
  });
});

const BUNDLED = join(__dirname, '..', '..', '..', 'apps', 'web', 'public', 'cities', 'pune-bibwewadi.json');
describe.skipIf(!existsSync(BUNDLED))('bundled Pune dataset (real OSM data)', () => {
  const c = decodeCityBundle(JSON.parse(readFileSync(BUNDLED, 'utf8')));
  it('is real, attributed OpenStreetMap data for the configured region', () => {
    expect(c.provenance.source).toBe('OpenStreetMap');
    expect(c.provenance.attribution).toBe('© OpenStreetMap contributors');
    expect(c.provenance.bbox).toEqual([18.445, 73.85, 18.481, 73.888]);
    expect(c.nodeCount).toBeGreaterThan(1000);
    expect(c.buildingCount).toBeGreaterThan(1000);
    expect(c.stats.buildings.bySource.height + c.stats.buildings.bySource.levels + c.stats.buildings.bySource.estimate).toBe(c.buildingCount);
  });
  it('has segment lengths consistent with the mapped coordinates', () => {
    for (let s = 0; s < c.segCount; s += 7) {
      let len = 0;
      for (let p = c.segPtOff[s]!; p < c.segPtOff[s + 1]! - 1; p++) len += Math.hypot(c.segXY[2 * p + 2]! - c.segXY[2 * p]!, c.segXY[2 * p + 3]! - c.segXY[2 * p + 1]!);
      // The local projection is accurate to well under 1 % across a few km.
      expect(Math.abs(len - c.segLen[s]!)).toBeLessThan(Math.max(0.5, c.segLen[s]! * 0.01));
    }
  });
  it('every footprint is a valid ring', () => {
    for (let b = 0; b < c.buildingCount; b++) expect(c.bRingOff[b + 1]! - c.bRingOff[b]!).toBeGreaterThanOrEqual(3);
  });
});
