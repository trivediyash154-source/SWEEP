/**
 * Engine benchmarks. Run: pnpm bench
 * Prints measured wall-clock times for representative inputs on THIS machine.
 * Results are written to bench/results.json; nothing is hard-coded.
 */
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { solveChinesePostman } from '../src/index.js';
import { EXAMPLES, syntheticCity } from '../src/examples/index.js';

interface Row { name: string; vertices: number; edges: number; odd: number; medianMs: number; minMs: number; runs: number }

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
for (const ex of EXAMPLES) if (ex.id !== 'twin-districts') rows.push(bench(ex.title, ex.graph, 9));
for (const [cols, rowsN] of [[30, 22], [40, 30], [50, 36], [60, 44]] as const) {
  const g = syntheticCity({ cols, rows: rowsN, spacing: 100, seed: cols * 1000 + rowsN, removeFraction: 0.13, diagonals: Math.round(cols / 2), name: `synthetic ${cols}×${rowsN}` });
  rows.push(bench(g.name!, g, 3));
}
console.table(rows);
const out = { machine: { cpus: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, node: process.version, platform: `${os.platform()} ${os.release()}` }, measuredAt: new Date().toISOString(), rows };
writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(out, null, 2));
