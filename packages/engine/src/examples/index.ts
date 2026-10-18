import type { Edge, Graph, Point, Vertex } from '../types.js';

/**
 * Bundled, deterministic example networks. All coordinates are in metres in a
 * local planar frame (x → east, y → south, matching screen space). Unless a
 * weight is given explicitly, an edge's weight is its drawn length rounded to
 * the nearest metre. All data here is SYNTHETIC; the Königsberg layout is a
 * schematic of the historical problem, not survey data.
 */

export interface ExampleMeta {
  id: string;
  title: string;
  subtitle: string;
  /** What the example demonstrates mathematically. */
  teaches: string;
  /** What the solver is expected to report (verified by the test suite). */
  expectation: string;
  category: 'learn' | 'core' | 'edge-case' | 'scale';
}

export interface Example extends ExampleMeta {
  graph: Graph;
}

type VSpec = [id: string, x: number, y: number, label?: string];
type ESpec = [id: string, u: string, v: string, opts?: { w?: number; required?: boolean; name?: string; shape?: Point[] }];

function build(name: string, description: string, vs: VSpec[], es: ESpec[], depotId?: string): Graph {
  const vertices: Vertex[] = vs.map(([id, x, y, label]) => ({ id, x, y, ...(label ? { label } : {}) }));
  const pos = new Map(vertices.map((v) => [v.id, v]));
  const edges: Edge[] = es.map(([id, u, v, o = {}]) => {
    const a = pos.get(u)!;
    const b = pos.get(v)!;
    const pts: Point[] = [[a.x, a.y], ...(o.shape ?? []), [b.x, b.y]];
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    return {
      id,
      u,
      v,
      weight: o.w ?? Math.round(len),
      required: o.required ?? true,
      ...(o.name ? { name: o.name } : {}),
      ...(o.shape ? { shape: o.shape } : {}),
    };
  });
  return { format: 'sweep.graph', version: 1, name, description, units: 'm', vertices, edges, ...(depotId ? { depotId } : {}) };
}

/** mulberry32 — tiny deterministic PRNG for synthetic cities. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic synthetic street grid: a jittered lattice with a seeded
 * fraction of blocks merged (edges removed) and a few diagonal avenues.
 * The largest connected component is kept, so the result is always connected.
 */
export function syntheticCity(opts: { cols: number; rows: number; spacing: number; seed: number; removeFraction: number; diagonals: number; name: string; requiredFraction?: number }): Graph {
  const rnd = mulberry32(opts.seed);
  const vs: Vertex[] = [];
  const id = (c: number, r: number): string => `v${r}_${c}`;
  for (let r = 0; r < opts.rows; r++) {
    for (let c = 0; c < opts.cols; c++) {
      const jx = (rnd() - 0.5) * opts.spacing * 0.28;
      const jy = (rnd() - 0.5) * opts.spacing * 0.28;
      vs.push({ id: id(c, r), x: Math.round(c * opts.spacing + jx + r * opts.spacing * 0.06), y: Math.round(r * opts.spacing * 0.86 + jy) });
    }
  }
  const pos = new Map(vs.map((v) => [v.id, v]));
  const candidate: Array<[string, string]> = [];
  for (let r = 0; r < opts.rows; r++) {
    for (let c = 0; c < opts.cols; c++) {
      if (c + 1 < opts.cols) candidate.push([id(c, r), id(c + 1, r)]);
      if (r + 1 < opts.rows) candidate.push([id(c, r), id(c, r + 1)]);
    }
  }
  const kept = candidate.filter(() => rnd() >= opts.removeFraction);
  for (let d = 0; d < opts.diagonals; d++) {
    const c = Math.floor(rnd() * (opts.cols - 1));
    const r = Math.floor(rnd() * (opts.rows - 1));
    kept.push(rnd() < 0.5 ? [id(c, r), id(c + 1, r + 1)] : [id(c + 1, r), id(c, r + 1)]);
  }
  // keep largest component
  const parent = new Map<string, string>(vs.map((v) => [v.id, v.id]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (const [a, b] of kept) parent.set(find(a), find(b));
  const sizes = new Map<string, number>();
  for (const v of vs) sizes.set(find(v.id), (sizes.get(find(v.id)) ?? 0) + 1);
  const bigRoot = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const inMain = (x: string): boolean => find(x) === bigRoot;
  const usedV = new Set<string>();
  const edges: Edge[] = [];
  const seen = new Set<string>();
  kept.forEach(([a, b]) => {
    if (!inMain(a) || !inMain(b)) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    const pa = pos.get(a)!;
    const pb = pos.get(b)!;
    usedV.add(a);
    usedV.add(b);
    edges.push({
      id: `e${edges.length}`,
      u: a,
      v: b,
      weight: Math.round(Math.hypot(pa.x - pb.x, pa.y - pb.y)),
      required: opts.requiredFraction === undefined ? true : rnd() < opts.requiredFraction,
    });
  });
  return {
    format: 'sweep.graph',
    version: 1,
    name: opts.name,
    description: `Synthetic district generated deterministically (seed ${opts.seed}).`,
    units: 'm',
    vertices: vs.filter((v) => usedV.has(v.id)),
    edges,
  };
}

const konigsberg: Example = {
  id: 'konigsberg',
  title: 'Königsberg, 1736',
  subtitle: 'Four landmasses, seven bridges',
  teaches: 'Euler’s original puzzle. All four landmasses have odd degree, so no walk can cross every bridge exactly once; the postman must repeat two bridges.',
  expectation: '4 odd vertices; parallel edges; some bridges must be crossed twice.',
  category: 'learn',
  graph: build(
    'Königsberg, 1736',
    'Schematic of Euler’s seven bridges. Bridge lengths are illustrative.',
    [
      ['N', 420, 90, 'North bank'],
      ['S', 420, 520, 'South bank'],
      ['K', 330, 305, 'Kneiphof island'],
      ['L', 700, 305, 'Lomse island'],
    ],
    [
      ['b1', 'N', 'K', { name: 'Krämer Bridge', shape: [[300, 190]] }],
      ['b2', 'N', 'K', { name: 'Schmiede Bridge', shape: [[420, 200]] }],
      ['b3', 'S', 'K', { name: 'Grüne Bridge', shape: [[300, 420]] }],
      ['b4', 'S', 'K', { name: 'Köttel Bridge', shape: [[420, 410]] }],
      ['b5', 'K', 'L', { name: 'Honig Bridge' }],
      ['b6', 'N', 'L', { name: 'Holz Bridge', shape: [[600, 170]] }],
      ['b7', 'S', 'L', { name: 'Hohe Bridge', shape: [[600, 440]] }],
    ],
    'K',
  ),
};

const heritageLoop: Example = {
  id: 'heritage-loop',
  title: 'Heritage Loop',
  subtitle: 'Every intersection already even',
  teaches: 'When every vertex has even degree the graph is Eulerian: one closed walk covers every street exactly once, with zero repeated distance.',
  expectation: '0 odd vertices; repeated distance 0; route = lower bound.',
  category: 'learn',
  graph: build(
    'Heritage Loop',
    'Two linked loops around a central square; Eulerian as drawn.',
    [
      ['A', 120, 120],
      ['B', 360, 100],
      ['C', 420, 300],
      ['D', 150, 330],
      ['E', 640, 180],
      ['F', 700, 420],
      ['G', 470, 520],
    ],
    [
      ['h1', 'A', 'B', { name: 'Gate Street' }],
      ['h2', 'B', 'C', { name: 'Clock Lane' }],
      ['h3', 'C', 'D', { name: 'Fountain Walk' }],
      ['h4', 'D', 'A', { name: 'Wall Road' }],
      ['h5', 'C', 'E', { name: 'Garden Row' }],
      ['h6', 'E', 'F', { name: 'Orchard Way' }],
      ['h7', 'F', 'G', { name: 'Mill Lane' }],
      ['h8', 'G', 'C', { name: 'Chapel Street' }],
    ],
    'A',
  ),
};

const riverside: Example = {
  id: 'riverside-ladder',
  title: 'Riverside Ladder',
  subtitle: 'Exactly two odd intersections',
  teaches: 'With exactly two odd vertices the optimal fix is a single shortest path between them; here it is the middle rung.',
  expectation: '2 odd vertices; one matched pair; duplicated path = middle rung.',
  category: 'core',
  graph: build(
    'Riverside Ladder',
    'Two parallel embankments joined by three crossings.',
    [
      ['t0', 80, 120],
      ['t1', 360, 110],
      ['t2', 660, 130],
      ['b0', 90, 380],
      ['b1', 370, 360],
      ['b2', 650, 390],
    ],
    [
      ['r1', 't0', 't1', { name: 'Upper Embankment' }],
      ['r2', 't1', 't2', { name: 'Upper Embankment' }],
      ['r3', 'b0', 'b1', { name: 'Lower Embankment' }],
      ['r4', 'b1', 'b2', { name: 'Lower Embankment' }],
      ['c0', 't0', 'b0', { name: 'West Crossing' }],
      ['c1', 't1', 'b1', { name: 'Middle Crossing' }],
      ['c2', 't2', 'b2', { name: 'East Crossing' }],
    ],
    't0',
  ),
};

function oldTown(): Example {
  const xs = [80, 230, 400, 600];
  const ys = [90, 230, 360, 520];
  const vs: VSpec[] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) vs.push([`g${r}${c}`, xs[c]! + (r % 2) * 14, ys[r]! + (c % 2) * 10]);
  const es: ESpec[] = [];
  let n = 0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (c < 3) es.push([`s${n++}`, `g${r}${c}`, `g${r}${c + 1}`]);
    if (r < 3) es.push([`s${n++}`, `g${r}${c}`, `g${r + 1}${c}`]);
  }
  return {
    id: 'old-town-grid',
    title: 'Old Town Grid',
    subtitle: 'Eight odd intersections on the boundary',
    teaches: 'Every boundary T-junction has degree 3. The solver must pair eight odd vertices optimally; uneven block sizes make the choice non-obvious.',
    expectation: '8 odd vertices; 4 matched pairs; matching certified optimal.',
    category: 'core',
    graph: build('Old Town Grid', 'A 4 × 4 block grid with uneven block sizes.', vs, es, 'g00'),
  };
}

const greedyTrap: Example = {
  id: 'greedy-trap',
  title: 'Crescent Quay',
  subtitle: 'Where greedy pairing fails',
  teaches: 'The two closest odd intersections are b and c, but pairing them forces the long a–d path. Exact matching instead pairs each dead end with its neighbour.',
  expectation: 'Optimal added distance 80 m; greedy pairing adds 140 m.',
  category: 'core',
  graph: build(
    'Crescent Quay',
    'A quay road with two dead ends and a crescent behind it.',
    [
      ['a', 60, 380, 'West dead end'],
      ['b', 260, 380],
      ['c', 410, 380],
      ['d', 610, 380, 'East dead end'],
      ['x', 260, 170],
      ['y', 410, 170],
    ],
    [
      ['q1', 'a', 'b', { w: 40, name: 'West Quay' }],
      ['q2', 'b', 'c', { w: 30, name: 'Quay Centre' }],
      ['q3', 'c', 'd', { w: 40, name: 'East Quay' }],
      ['k1', 'b', 'x', { w: 60, name: 'Crescent', shape: [[220, 270]] }],
      ['k2', 'x', 'y', { w: 50, name: 'Crescent', shape: [[335, 120]] }],
      ['k3', 'y', 'c', { w: 60, name: 'Crescent', shape: [[450, 270]] }],
    ],
    'b',
  ),
};

const fourCorners: Example = {
  id: 'four-corners',
  title: 'Four Corners',
  subtitle: 'Two equally optimal pairings',
  teaches: 'A square block with both diagonals: all four corners are odd. Pairing along either pair of opposite sides costs the same, so two optimal routes exist. SWEEP reports the tie and picks one deterministically.',
  expectation: '4 odd vertices; optimal pairing count = 2.',
  category: 'edge-case',
  graph: build(
    'Four Corners',
    'A square with two diagonal avenues.',
    [
      ['NW', 160, 120],
      ['NE', 560, 120],
      ['SE', 560, 520],
      ['SW', 160, 520],
    ],
    [
      ['n', 'NW', 'NE', { name: 'North Street' }],
      ['e', 'NE', 'SE', { name: 'East Street' }],
      ['s', 'SE', 'SW', { name: 'South Street' }],
      ['w', 'SW', 'NW', { name: 'West Street' }],
      ['d1', 'NW', 'SE', { name: 'Diagonal Avenue' }],
      ['d2', 'NE', 'SW', { name: 'Cross Avenue' }],
    ],
    'NW',
  ),
};

const twinDistricts: Example = {
  id: 'twin-districts',
  title: 'Twin Districts',
  subtitle: 'Required streets in two separate groups',
  teaches: 'Covering separated groups of required streets is the Rural Postman Problem (NP-hard). SWEEP refuses to guess, explains why, and suggests connecting streets to mark as required.',
  expectation: 'Validation error REQUIRED_DISCONNECTED with a connector suggestion.',
  category: 'edge-case',
  graph: build(
    'Twin Districts',
    'Two serviced districts joined only by unserviced connector roads.',
    [
      ['w1', 80, 140],
      ['w2', 260, 120],
      ['w3', 270, 330],
      ['w4', 90, 340],
      ['m1', 420, 220],
      ['m2', 420, 470],
      ['e1', 560, 150],
      ['e2', 730, 140],
      ['e3', 740, 350],
      ['e4', 570, 360],
    ],
    [
      ['wa', 'w1', 'w2', { name: 'West Row' }],
      ['wb', 'w2', 'w3', { name: 'West Row' }],
      ['wc', 'w3', 'w4', { name: 'West Row' }],
      ['wd', 'w4', 'w1', { name: 'West Row' }],
      ['ea', 'e1', 'e2', { name: 'East Row' }],
      ['eb', 'e2', 'e3', { name: 'East Row' }],
      ['ec', 'e3', 'e4', { name: 'East Row' }],
      ['ed', 'e4', 'e1', { name: 'East Row' }],
      ['l1', 'w2', 'm1', { required: false, name: 'Link Road' }],
      ['l2', 'm1', 'e1', { required: false, name: 'Link Road' }],
      ['l3', 'w3', 'm2', { required: false, name: 'Southern Bypass' }],
      ['l4', 'm2', 'e4', { required: false, name: 'Southern Bypass' }],
    ],
  ),
};

const plaza: Example = {
  id: 'plaza-crossing',
  title: 'Plaza Crossing',
  subtitle: 'A zero-length link',
  teaches: 'Two nodes model the same plaza and are joined by a zero-length link. Zero weights are valid: pairing the plaza nodes costs nothing.',
  expectation: 'Contains a zero-weight edge; matching uses it at zero cost.',
  category: 'edge-case',
  graph: build(
    'Plaza Crossing',
    'A plaza modelled as two nodes joined by a 0 m link.',
    [
      ['p1', 330, 300, 'Plaza (west)'],
      ['p2', 410, 300, 'Plaza (east)'],
      ['n1', 180, 100],
      ['s1', 180, 500],
      ['n2', 580, 110],
      ['s2', 570, 500],
    ],
    [
      ['z', 'p1', 'p2', { w: 0, name: 'Plaza link' }],
      ['a1', 'p1', 'n1', { name: 'North-west Arcade' }],
      ['a2', 'p1', 's1', { name: 'South-west Arcade' }],
      ['a3', 'n1', 's1', { name: 'West Promenade' }],
      ['a4', 'p2', 'n2', { name: 'North-east Arcade' }],
      ['a5', 'p2', 's2', { name: 'South-east Arcade' }],
      ['a6', 'n2', 's2', { name: 'East Promenade' }],
    ],
    'p1',
  ),
};

function marketAvenues(): Example {
  const vs: VSpec[] = [];
  const es: ESpec[] = [];
  const cols = 5;
  const rows = 4;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) vs.push([`m${r}${c}`, 70 + c * 150 + (r % 2) * 8, 80 + r * 140]);
  let n = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (c < cols - 1) {
      const req = r === 0 || r === rows - 1;
      es.push([`h${n++}`, `m${r}${c}`, `m${r}${c + 1}`, { required: req, name: r === 0 ? 'North Market Avenue' : r === rows - 1 ? 'South Market Avenue' : 'Side Street' }]);
    }
    if (r < rows - 1) {
      const req = c === 0;
      es.push([`v${n++}`, `m${r}${c}`, `m${r + 1}${c}`, { required: req, name: c === 0 ? 'West Avenue' : c === cols - 1 ? 'East Avenue' : 'Side Street' }]);
    }
  }
  return {
    id: 'market-avenues',
    title: 'Market Avenues',
    subtitle: 'Only the avenues need service',
    teaches: 'The serviced avenues form a C shape whose two open ends are odd. Driving back along the serviced streets would cost 1,620 m; the optimal route instead returns along the unserviced East Avenue as a 420 m "deadhead".',
    expectation: '2 odd vertices; the duplicated path uses optional streets only (deadhead).',
    category: 'core',
    graph: build('Market Avenues', 'Avenues are serviced; side streets and East Avenue are optional.', vs, es, 'm00'),
  };
}

const meridian: Example = {
  id: 'meridian-district',
  title: 'Meridian District',
  subtitle: 'Synthetic district · scale test',
  teaches: 'A deterministic synthetic district with hundreds of intersections, used to exercise exact matching at realistic scale.',
  expectation: 'Hundreds of odd vertices; solved exactly; all checks pass.',
  category: 'scale',
  graph: syntheticCity({ cols: 22, rows: 16, spacing: 110, seed: 20260418, removeFraction: 0.13, diagonals: 14, name: 'Meridian District' }),
};

export const EXAMPLES: Example[] = [konigsberg, heritageLoop, riverside, oldTown(), greedyTrap, fourCorners, twinDistricts, plaza, marketAvenues(), meridian];

export function getExample(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id);
}

/** The deterministic network that drives the landing-page hero scene. */
export function heroCity(): Graph {
  return syntheticCity({ cols: 11, rows: 8, spacing: 120, seed: 7331, removeFraction: 0.16, diagonals: 4, name: 'Hero District' });
}
