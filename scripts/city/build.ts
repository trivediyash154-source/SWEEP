/**
 * Build the bundled city dataset from cached Overpass tiles.
 *
 *   pnpm city:build pune-bibwewadi
 *
 * Reads data/cache/osm/<id>/ (written by acquire.ts), merges the tiles
 * (deduplicating features that appear in several tiles), converts and
 * validates them with @sweep/engine's buildCityBundle, and writes
 * apps/web/public/cities/<id>.json plus an index of available cities.
 * Missing tiles are recorded in the dataset's provenance, never hidden.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCityBundle, mergeElements, type OsmElement } from '../../packages/engine/src/city/bundle.js';
import { decodeCityBundle } from '../../packages/engine/src/city/decode.js';
import { buildingQuery, cacheDir, loadManifest, loadRegion, restrictionQuery, streetQuery, tilesOf } from './acquire.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'apps', 'web', 'public', 'cities');

export function build(id: string): { file: string; bytes: number; stats: unknown } {
  const t0 = performance.now();
  const r = loadRegion(id);
  const m = loadManifest(r);
  const tiles = tilesOf(r);
  const read = (file: string): OsmElement[] => (JSON.parse(readFileSync(join(cacheDir(id), 'tiles', file), 'utf8')) as { elements: OsmElement[] }).elements;
  const streets: OsmElement[][] = [];
  const buildings: OsmElement[][] = [];
  const missing: string[] = [];
  const osmBase: string[] = [];
  const fetched: string[] = [];
  const endpoints = new Set<string>();
  for (const t of tiles) {
    for (const kind of ['streets', 'buildings'] as const) {
      const e = m.entries[`${t.key}:${kind}`];
      if (e?.status === 'ok' && existsSync(join(cacheDir(id), 'tiles', e.file))) {
        (kind === 'streets' ? streets : buildings).push(read(e.file));
        if (e.osmBase) osmBase.push(e.osmBase);
        if (e.fetchedAt) fetched.push(e.fetchedAt);
        if (e.endpoint) endpoints.add(e.endpoint);
      } else missing.push(`${t.key} ${kind} (${t.bbox.join(', ')})`);
    }
  }
  const rest = m.entries['region:restrictions'];
  const restrictions = rest?.status === 'ok' ? read(rest.file) : [];
  if (rest?.status !== 'ok') missing.push('region turn restrictions');
  const mergedStreets = mergeElements(streets);
  const mergedBuildings = mergeElements(buildings);
  osmBase.sort();
  fetched.sort();
  const { bundle, report } = buildCityBundle({
    id: r.id,
    name: r.name,
    description: r.description,
    bbox: r.bbox,
    ...(r.focus ? { focus: { lonlat: r.focus.lonlat, label: r.focus.label } } : {}),
    roadClasses: r.roadClasses,
    streets: mergedStreets.elements,
    buildings: mergedBuildings.elements,
    restrictions,
    provenance: {
      endpoints: [...endpoints],
      osmBase: [osmBase[0] ?? 'unknown', osmBase[osmBase.length - 1] ?? 'unknown'],
      fetched: [fetched[0] ?? 'unknown (adopted from an earlier download)', fetched[fetched.length - 1] ?? 'unknown'],
      tiles: { total: tiles.length * 2 + 1, ok: tiles.length * 2 + 1 - missing.length, missing },
      queries: {
        streets: streetQuery([0, 0, 0, 0], r.roadClasses).replace('0.00000,0.00000,0.00000,0.00000', '<tile bbox>'),
        buildings: buildingQuery([0, 0, 0, 0]).replace('0.00000,0.00000,0.00000,0.00000', '<tile bbox>'),
        restrictions: restrictionQuery([0, 0, 0, 0]).replace('0.00000,0.00000,0.00000,0.00000', '<region bbox>'),
      },
      limitations: [
        `Tiles overlap at their borders; ${mergedStreets.duplicates.toLocaleString('en-US')} street elements and ${mergedBuildings.duplicates.toLocaleString('en-US')} building elements returned by more than one tile were merged.`,
        'Footpaths, cycleways and other non-vehicular ways were not acquired; walking and cycling routes use the road network.',
        ...(r.focus?.source ? [`Focus point: ${r.focus.source}.`] : []),
      ],
    },
  });
  decodeCityBundle(bundle); // must round-trip
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${id}.json`);
  const text = JSON.stringify(bundle);
  writeFileSync(file, text);
  const indexFile = join(OUT_DIR, 'index.json');
  const index: { cities: unknown[] } = existsSync(indexFile) ? (JSON.parse(readFileSync(indexFile, 'utf8')) as { cities: unknown[] }) : { cities: [] };
  const entry = { id, name: r.name, description: r.description, bbox: r.bbox, file: `cities/${id}.json`, bytes: Buffer.byteLength(text), stats: { areaKm2: bundle.stats.areaKm2, nodes: bundle.stats.nodes, segments: bundle.stats.segments, roadLengthKm: bundle.stats.roadLengthKm, buildings: bundle.stats.buildings.total }, osmBase: bundle.provenance.osmBase, complete: missing.length === 0 };
  index.cities = [...index.cities.filter((c) => (c as { id: string }).id !== id), entry];
  writeFileSync(indexFile, JSON.stringify(index, null, 1));
  console.log(report.notes.join('\n'));
  console.log(`\nwrote ${file} (${(Buffer.byteLength(text) / 1024 / 1024).toFixed(2)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)} s; ${missing.length} missing tile file(s)`);
  return { file, bytes: Buffer.byteLength(text), stats: bundle.stats };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const id = process.argv[2] ?? 'pune-bibwewadi';
  const res = build(id);
  console.log(JSON.stringify(res.stats, null, 1));
}
