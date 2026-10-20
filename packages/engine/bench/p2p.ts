/**
 * Point-to-point routing benchmark on the bundled real dataset.
 *   npx tsx bench/p2p.ts [path/to/city.json] [--json out.json]
 * Prints measured preprocessing times and median query times on THIS machine;
 * nothing is hard-coded.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { decodeCityBundle } from '../src/city/decode.js';
import { rng, RoutingEngine, PROFILES, type AlgorithmId, type Objective } from '../src/p2p/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith('.json') && args[args.indexOf(a) - 1] !== '--json') ?? join(here, '..', '..', '..', 'apps', 'web', 'public', 'cities', 'pune-bibwewadi.json');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;
const city = decodeCityBundle(JSON.parse(readFileSync(file, 'utf8')));
const ALGOS: AlgorithmId[] = ['dijkstra', 'astar', 'bidirectional', 'alt', 'ch'];
const QUERIES = 200;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};

console.log(`${city.name}: ${city.nodeCount.toLocaleString('en-US')} intersections, ${city.segCount.toLocaleString('en-US')} segments, ${city.restrictions.length} turn restrictions`);
console.log(`machine: ${os.cpus()[0]?.model ?? 'unknown'} × ${os.cpus().length}, node ${process.version}\n`);
const rows: Record<string, unknown>[] = [];
for (const profile of PROFILES) {
  const e = new RoutingEngine(city, profile);
  const nodes: number[] = [];
  for (let n = 0; n < city.nodeCount; n++) if (e.graph.nodeOutOff[n + 1]! > e.graph.nodeOutOff[n]! && e.graph.nodeInOff[n + 1]! > e.graph.nodeInOff[n]!) nodes.push(n);
  for (const objective of ['time', 'distance'] as Objective[]) {
    const lm = e.landmarks(objective);
    const ch = e.hierarchy(objective);
    const r = rng(profile.length * 7 + objective.length);
    const qs: { origin: number; destination: number; objective: Objective }[] = [];
    while (qs.length < QUERIES) {
      const q = { origin: nodes[Math.floor(r() * nodes.length)]!, destination: nodes[Math.floor(r() * nodes.length)]!, objective };
      if (e.query('dijkstra', q).result.found) qs.push(q);
    }
    const row: Record<string, unknown> = {
      profile,
      objective,
      arcs: e.graph.stats.allowedArcs,
      transitions: e.graph.stats.transitions,
      graphMs: +e.buildMs.toFixed(1),
      altPrepMs: +lm.ms.toFixed(1),
      altBytes: lm.bytes,
      chPrepMs: +ch.ms.toFixed(1),
      chShortcuts: ch.shortcuts,
      chBytes: ch.bytes,
    };
    for (const a of ALGOS) {
      const times: number[] = [];
      const exp: number[] = [];
      for (const q of qs) {
        const res = e.query(a, q, { repeat: 3 }).result;
        times.push(res.runtimeMs);
        exp.push(res.expanded);
      }
      row[`${a}MedianMs`] = +median(times).toFixed(3);
      row[`${a}MedianExpanded`] = median(exp);
    }
    rows.push(row);
    console.log(
      `${profile.padEnd(8)} ${objective.padEnd(9)} arcs ${String(row.arcs).padStart(6)}  prep: ALT ${row.altPrepMs} ms, CH ${row.chPrepMs} ms (${ch.shortcuts} shortcuts)  median query ms: ` +
        ALGOS.map((a) => `${a} ${row[`${a}MedianMs`]} (${row[`${a}MedianExpanded`]} settled)`).join(', '),
    );
  }
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ dataset: city.id, nodes: city.nodeCount, segments: city.segCount, measuredAt: new Date().toISOString(), machine: os.cpus()[0]?.model, rows }, null, 1));
