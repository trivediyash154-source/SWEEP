/**
 * Coverage and fleet-planning benchmarks on the bundled real Pune dataset.
 * Run: npx tsx packages/engine/bench/coverage.ts
 * Prints measured wall-clock times on THIS machine; nothing is hard-coded.
 */
import { readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import { decodeCityBundle } from '../src/city/decode.js';
import { zoneCoverageGraph, nearestNode, type Zone } from '../src/coverage/zone.js';
import { solveZoneCoverage } from '../src/coverage/solveCoverage.js';
import { planFleet } from '../src/coverage/carp.js';

const file = new URL('../../../apps/web/public/cities/pune-bibwewadi.json', import.meta.url);
if (!existsSync(file)) {
  console.error('apps/web/public/cities/pune-bibwewadi.json not found; build the city dataset first.');
  process.exit(1);
}
const city = decodeCityBundle(JSON.parse(readFileSync(file, 'utf8')));
const cx = (city.bounds.minX + city.bounds.maxX) / 2;
const cy = (city.bounds.minY + city.bounds.maxY) / 2;
const depotNode = nearestNode(city, cx, cy);
const depotId = `n${city.nodeOsm[depotNode]}`;
console.log(`machine: ${os.cpus()[0]?.model ?? 'unknown'} ×${os.cpus().length}, node ${process.version}`);
console.log(`dataset: ${city.name}: ${city.nodeCount} intersections, ${city.segCount} segments, ${city.stats.roadLengthKm} km, OSM base ${city.provenance.osmBase.join(' … ')}`);

const zones: { name: string; zone: Zone }[] = [
  { name: 'small (circle r = 400 m, 0.50 km²)', zone: { kind: 'circle', cx, cy, r: 400 } },
  { name: 'medium (circle r = 800 m, 2.01 km²)', zone: { kind: 'circle', cx, cy, r: 800 } },
  { name: 'full network', zone: { kind: 'rect', minX: -1e9, maxX: 1e9, minY: -1e9, maxY: 1e9 } },
];
const ms = (x: number): string => `${Math.round(x)} ms`;
const km = (m: number): string => `${(m / 1000).toFixed(2)} km`;
for (const { name, zone } of zones) {
  for (const direction of ['directed', 'undirected'] as const) {
    const t0 = performance.now();
    const z = zoneCoverageGraph(city, { zone, direction });
    const t1 = performance.now();
    const r = solveZoneCoverage(z.graph, { direction, depotId });
    const t2 = performance.now();
    if (!r.ok) {
      console.log(`${name} · ${direction}: FAILED ${r.message}`);
      continue;
    }
    console.log(
      `${name} · ${direction}: ${z.report.requiredSegments} required segments (${z.report.requiredKm} km) | ${r.method}${r.optimal ? ' (optimal)' : ''} | route ${km(r.route.totalDistance)}, lower bound ${km(r.lowerBound?.value ?? NaN)} (${r.lowerBound?.method}), gap ${r.gap === null ? 'n/a' : (r.gap * 100).toFixed(2) + ' %'} | connectors ${r.connectors.paths}, excluded ${r.excluded.unserviceable.length} | zone ${ms(t1 - t0)}, solve ${ms(t2 - t1)} (solve ${ms(r.timingsMs.solve)}, bound ${ms(r.timingsMs.bound)}, verify ${ms(r.timingsMs.verify)}) | checks ${r.checks.every((c) => c.passed) ? 'pass' : 'FAIL'}`,
    );
    if (name.startsWith('full')) continue;
    for (const [label, opts] of [
      ['4 vehicles, min makespan', { vehicles: 4, objective: 'min-makespan' as const }],
      ['6 vehicles, capacity 1.5 t at 150 kg/km, 6 h shift', { vehicles: 6, objective: 'min-total' as const, capacity: 1500, demandPerKm: 150, shiftSeconds: 6 * 3600 }],
    ] as const) {
      const t3 = performance.now();
      const p = planFleet(z.graph, { ...opts, depotId, direction, serviceSpeedKmh: 8, deadheadSpeedKmh: 25, coverage: r });
      const t4 = performance.now();
      if (!p.ok) {
        console.log(`   fleet (${label}): FAILED ${p.message}`);
        continue;
      }
      console.log(
        `   fleet (${label}): ${p.totals.vehiclesUsed} routes, total ${km(p.totals.distance)} (bound ${km(p.lowerBounds.totalDistance.value)}), makespan ${(p.totals.makespanSeconds / 3600).toFixed(2)} h (bound ${(p.lowerBounds.makespanSeconds.value / 3600).toFixed(2)} h), feasible ${p.feasibility.ok}, valid ${p.validation.ok} | ${ms(t4 - t3)} (table ${ms(p.timingsMs.table)}, split ${ms(p.timingsMs.split)}, local search ${ms(p.timingsMs.localSearch)}: ${p.localSearch.applied} moves / ${p.localSearch.evaluations} evaluations)`,
      );
    }
  }
}
