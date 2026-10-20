/**
 * Engine benchmarks. Run: pnpm bench
 * Prints measured wall-clock times for representative inputs on THIS machine.
 * Results are written to bench/results.json; nothing is hard-coded.
 */
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { solveChinesePostman, solveDirectedPostman, solveFleet, findUnserviceableStreets, type Graph } from '../src/index.js';
import { EXAMPLES, getExample, syntheticCity } from '../src/examples/index.js';

interface Row { name: string; vertices: number; edges: number; odd: number; medianMs: number; minMs: number; runs: number }
interface TimedRow { name: string; vertices: number; edges: number; detail: string; medianMs: number; minMs: number; runs: number }

const LIMITS = { maxOddVertices: 5000, maxEdges: 200000, maxVertices: 200000 };

function timed(name: string, graph: Graph, runs: number, run: () => string): TimedRow {
  const times: number[] = [];
  let detail = '';
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    detail = run();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return { name, vertices: graph.vertices.length, edges: graph.edges.length, detail, medianMs: +times[Math.floor(times.length / 2)]!.toFixed(2), minMs: +times[0]!.toFixed(2), runs };
}

/** A synthetic city where every third street is one-way (alternating directions), made feasible the same way as the Zurich sample: streets that cannot be serviced on a closed legal route are optional. */
function onewayCity(cols: number, rowsN: number): Graph {
  const g = syntheticCity({ cols, rows: rowsN, spacing: 100, seed: cols * 7 + rowsN, removeFraction: 0.1, diagonals: 0, name: `one-way ${cols}×${rowsN}` });
  const edges = g.edges.map((e, i) => (i % 3 === 0 ? (i % 2 === 0 ? { ...e, oneway: true } : { ...e, u: e.v, v: e.u, shape: e.shape ? [...e.shape].reverse() : e.shape, oneway: true }) : e));
  const graph: Graph = { ...g, edges };
  const bad = findUnserviceableStreets(graph);
  const optional = new Set([...bad.unreachable, ...bad.noReturn]);
  return { ...graph, edges: graph.edges.map((e) => (optional.has(e.id) ? { ...e, required: false } : e)) };
}

function bench(name: string, graph: Parameters<typeof solveChinesePostman>[0], runs = 5): Row {
  const times: number[] = [];
  let odd = 0;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const r = solveChinesePostman(graph, { limits: { maxOddVertices: 5000, maxEdges: 200000, maxVertices: 200000 } });
    times.push(performance.now() - t);
    if (!r.ok) throw new Error(`${name} failed`);
    if (!r.checks.every((c) => c.passed)) throw new Error(`${name} checks failed`);
    odd = r.oddVertexIds.length;
  }
  times.sort((a, b) => a - b);
  return { name, vertices: graph.vertices.length, edges: graph.edges.length, odd, medianMs: +times[Math.floor(times.length / 2)]!.toFixed(2), minMs: +times[0]!.toFixed(2), runs };
}

const rows: Row[] = [];
// Undirected solver: every solvable example without one-way streets (Zurich is benchmarked in directed mode below).
for (const ex of EXAMPLES) if (ex.id !== 'twin-districts' && !ex.graph.edges.some((e) => e.oneway)) rows.push(bench(ex.title, ex.graph, 9));
for (const [cols, rowsN] of [[30, 22], [40, 30], [50, 36], [60, 44]] as const) {
  const g = syntheticCity({ cols, rows: rowsN, spacing: 100, seed: cols * 1000 + rowsN, removeFraction: 0.13, diagonals: Math.round(cols / 2), name: `synthetic ${cols}×${rowsN}` });
  rows.push(bench(g.name!, g, 3));
}
console.table(rows);

// Directed solver (minimum-cost flow), 'both' service rule.
const directed: TimedRow[] = [];
const directedInputs: Graph[] = [getExample('zurich-altstadt')!.graph, onewayCity(20, 14), onewayCity(30, 22), onewayCity(40, 30)];
for (const g of directedInputs) {
  directed.push(
    timed(g.name ?? 'directed', g, 5, () => {
      const r = solveDirectedPostman(g, { twoWay: 'both', limits: LIMITS, crossCheckMaxObligations: 0 });
      if (!r.ok || !r.checks.every((c) => c.passed)) throw new Error(`${g.name} directed failed`);
      return `${r.input.requiredArcCount} required arcs, ${r.input.onewayEdgeCount} one-way`;
    }),
  );
}
console.table(directed);

// Fleets: base solve + split + verification.
const fleets: TimedRow[] = [];
const meridian = getExample('meridian-district')!.graph;
const big = syntheticCity({ cols: 40, rows: 30, spacing: 100, seed: 40030, removeFraction: 0.13, diagonals: 20, name: 'synthetic 40×30' });
for (const [g, k] of [[meridian, 3], [meridian, 8], [big, 4]] as const) {
  fleets.push(
    timed(`${g.name} · ${k} vehicles`, g, 3, () => {
      const r = solveFleet(g, { vehicles: k, mode: 'undirected' });
      if (!r.ok || !r.checks.every((c) => c.passed)) throw new Error(`${g.name} fleet failed`);
      return `${r.algorithm.split}, gap ${r.gapRatio.toFixed(3)}`;
    }),
  );
}
console.table(fleets);

const out = { machine: { cpus: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, node: process.version, platform: `${os.platform()} ${os.release()}` }, measuredAt: new Date().toISOString(), rows, directed, fleets };
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(out, null, 2));
