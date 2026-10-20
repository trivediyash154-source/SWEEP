import type { CityModel, TurnRestriction, WayAttrs } from '../city/types.js';

/**
 * SYNTHETIC city models for tests and examples. They are not map data and
 * carry provenance that says so.
 */
export interface SyntheticSegment {
  u: number;
  v: number;
  highway?: string;
  /** Mapped one-way u → v. */
  oneway?: boolean;
  tags?: Partial<WayAttrs>;
  /** Interior points (metres). */
  shape?: [number, number][];
}

export interface SyntheticCitySpec {
  nodes: [number, number][];
  segments: SyntheticSegment[];
  restrictions?: Omit<TurnRestriction, 'osmId' | 'value'>[];
}

export function syntheticCity(spec: SyntheticCitySpec): CityModel {
  const N = spec.nodes.length;
  const S = spec.segments.length;
  const nodeX = Float64Array.from(spec.nodes, (p) => p[0]);
  const nodeY = Float64Array.from(spec.nodes, (p) => p[1]);
  const segPtOff = new Int32Array(S + 1);
  spec.segments.forEach((s, i) => {
    segPtOff[i + 1] = segPtOff[i]! + 2 + (s.shape?.length ?? 0);
  });
  const segXY = new Float64Array(segPtOff[S]! * 2);
  const segLen = new Float64Array(S);
  const ways: WayAttrs[] = [];
  spec.segments.forEach((s, i) => {
    const pts: [number, number][] = [spec.nodes[s.u]!, ...(s.shape ?? []), spec.nodes[s.v]!];
    let k = segPtOff[i]! * 2;
    let len = 0;
    pts.forEach((p, j) => {
      segXY[k++] = p[0];
      segXY[k++] = p[1];
      if (j > 0) len += Math.hypot(p[0] - pts[j - 1]![0], p[1] - pts[j - 1]![1]);
    });
    segLen[i] = len;
    ways.push({ id: 1000 + i, highway: s.highway ?? 'residential', ...(s.oneway ? { oneway: 'yes' } : {}), ...(s.tags ?? {}) });
  });
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of spec.nodes) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return {
    id: 'synthetic',
    name: 'Synthetic test network',
    description: 'Synthetic network for tests; not map data.',
    origin: [0, 0],
    provenance: {
      source: 'OpenStreetMap',
      attribution: 'synthetic test data (not OpenStreetMap)',
      license: 'n/a',
      licenseUrl: '',
      endpoints: [],
      bbox: [0, 0, 0, 0],
      osmBase: ['n/a', 'n/a'],
      fetched: ['n/a', 'n/a'],
      builtAt: 'n/a',
      tiles: { total: 0, ok: 0, missing: [] },
      queries: { streets: '', buildings: '' },
      transformations: [],
      estimates: [],
      limitations: ['Synthetic test network; not map data.'],
    },
    stats: {
      areaKm2: 0,
      nodes: N,
      segments: S,
      roadLengthKm: 0,
      onewaySegments: 0,
      ways: S,
      restrictions: { mapped: spec.restrictions?.length ?? 0, unsupported: 0 },
      buildings: { total: 0, bySource: { height: 0, levels: 0, estimate: 0 }, invalid: {}, outsideRegion: 0, duplicates: 0 },
      roadClasses: {},
    },
    bounds: { minX, minY, maxX, maxY },
    region: { minX, minY, maxX, maxY },
    nodeCount: N,
    nodeOsm: Float64Array.from(spec.nodes, (_, i) => i + 1),
    nodeLon: new Float64Array(N),
    nodeLat: new Float64Array(N),
    nodeX,
    nodeY,
    segCount: S,
    segU: Int32Array.from(spec.segments, (s) => s.u),
    segV: Int32Array.from(spec.segments, (s) => s.v),
    segLen,
    segWay: Int32Array.from(spec.segments, (_, i) => i),
    segOneway: Uint8Array.from(spec.segments, (s) => (s.oneway ? 1 : 0)),
    segPtOff,
    segXY,
    ways,
    restrictions: (spec.restrictions ?? []).map((r, i) => ({ ...r, osmId: 9000 + i, value: r.kind === 'no' ? 'no_turn' : 'only_turn' })),
    buildingCount: 0,
    bOsm: new Float64Array(0),
    bRingOff: new Int32Array(1),
    bRingXY: new Float32Array(0),
    bHeight: new Float32Array(0),
    bHeightSrc: new Uint8Array(0),
    bLevels: new Int16Array(0),
    bKind: new Uint16Array(0),
    bKinds: [],
  };
}

/** Deterministic pseudo-random generator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random grid city: jittered nodes, some streets removed, random classes, one-ways, maxspeeds, access and turn restrictions. */
export function randomGridCity(seed: number, cols = 6, rows = 5): CityModel {
  const r = rng(seed);
  const nodes: [number, number][] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) nodes.push([x * 100 + (r() - 0.5) * 30, y * 100 + (r() - 0.5) * 30]);
  const classes = ['residential', 'residential', 'tertiary', 'primary', 'service', 'living_street', 'trunk'];
  const segments: SyntheticSegment[] = [];
  const id = (x: number, y: number): number => y * cols + x;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= cols || ny >= rows || r() < 0.12) continue;
        const flip = r() < 0.5;
        const u = flip ? id(nx, ny) : id(x, y);
        const v = flip ? id(x, y) : id(nx, ny);
        const tags: Partial<WayAttrs> = {};
        if (r() < 0.2) tags.maxspeed = String([20, 30, 40, 60][Math.floor(r() * 4)]);
        if (r() < 0.05) tags.access = 'no';
        if (r() < 0.05) tags.motor_vehicle = 'destination';
        const shape: [number, number][] | undefined = r() < 0.3 ? [[(nodes[u]![0] + nodes[v]![0]) / 2 + (r() - 0.5) * 20, (nodes[u]![1] + nodes[v]![1]) / 2 + (r() - 0.5) * 20]] : undefined;
        segments.push({ u, v, highway: classes[Math.floor(r() * classes.length)]!, oneway: r() < 0.25, tags, ...(shape ? { shape } : {}) });
      }
    }
  }
  // Turn restrictions at random intersections: pick a segment arriving at a node and another leaving it.
  const restrictions: Omit<TurnRestriction, 'osmId' | 'value'>[] = [];
  const at = new Map<number, number[]>();
  segments.forEach((s, i) => {
    for (const n of [s.u, s.v]) {
      const l = at.get(n) ?? [];
      l.push(i);
      at.set(n, l);
    }
  });
  for (const [via, segs] of at) {
    if (segs.length < 2 || r() > 0.2) continue;
    const a = segs[Math.floor(r() * segs.length)]!;
    let b = segs[Math.floor(r() * segs.length)]!;
    if (b === a) b = segs[(segs.indexOf(a) + 1) % segs.length]!;
    restrictions.push({ kind: r() < 0.7 ? 'no' : 'only', fromSeg: a, via, toSeg: b, ...(r() < 0.1 ? { except: 'bicycle' } : {}) });
  }
  return syntheticCity({ nodes, segments, restrictions });
}
