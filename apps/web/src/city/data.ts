import { decodeCityBundle, type CityModel } from '@sweep/engine';
import { roadRank, roadWidth, type BuildingInput } from './geometry';
import type { CityMeshes } from './GeoCityScene';

export interface CityIndexEntry {
  id: string;
  name: string;
  description: string;
  bbox: [number, number, number, number];
  file: string;
  bytes: number;
  stats: { areaKm2: number; nodes: number; segments: number; roadLengthKm: number; buildings: number };
  osmBase: [string, string];
  complete: boolean;
}

export const DEFAULT_CITY = 'pune-bibwewadi';

/** URL of a bundled city file, relative to the app's base (works for the server and the static build). */
export function cityUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.endsWith('/') ? base : `${base}/`}${path}`;
}

export async function fetchCityIndex(signal?: AbortSignal): Promise<CityIndexEntry[]> {
  const res = await fetch(cityUrl('cities/index.json'), signal ? { signal } : {});
  if (!res.ok) throw new Error(`City index unavailable (HTTP ${res.status}).`);
  return ((await res.json()) as { cities: CityIndexEntry[] }).cities;
}

export interface LoadedCity {
  city: CityModel;
  timings: { fetchMs: number; decodeMs: number; bytes: number };
}

export async function fetchCity(entry: Pick<CityIndexEntry, 'file'>, signal?: AbortSignal): Promise<LoadedCity> {
  const t0 = performance.now();
  const res = await fetch(cityUrl(entry.file), signal ? { signal } : {});
  if (!res.ok) throw new Error(`City data unavailable (HTTP ${res.status}).`);
  const text = await res.text();
  const t1 = performance.now();
  const city = decodeCityBundle(JSON.parse(text));
  const t2 = performance.now();
  return { city, timings: { fetchMs: t1 - t0, decodeMs: t2 - t1, bytes: text.length } };
}

/** Inputs for the geometry worker (copies, so the city model stays intact on the main thread). */
export function geometryRequest(city: CityModel): { buildings: BuildingInput; roads: { pts: Float64Array; off: Int32Array; widths: Float32Array; ranks: Float32Array } } {
  const widths = new Float32Array(city.segCount);
  const ranks = new Float32Array(city.segCount);
  for (let s = 0; s < city.segCount; s++) {
    const hw = city.ways[city.segWay[s]!]!.highway;
    widths[s] = roadWidth(hw);
    ranks[s] = roadRank(hw);
  }
  return {
    buildings: {
      count: city.buildingCount,
      ringOff: city.bRingOff.slice(),
      ringXY: city.bRingXY.slice(),
      height: city.bHeight.slice(),
      heightSrc: city.bHeightSrc.slice(),
      osm: city.bOsm.slice(),
    },
    roads: { pts: city.segXY.slice(), off: city.segPtOff.slice(), widths, ranks },
  };
}

export function buildMeshesInWorker(city: CityModel): Promise<CityMeshes> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' });
    const req = geometryRequest(city);
    worker.onmessage = (ev: MessageEvent<CityMeshes>) => {
      resolve(ev.data);
      worker.terminate();
    };
    worker.onerror = (e) => {
      reject(new Error(e.message || 'Geometry worker failed.'));
      worker.terminate();
    };
    const t = req.buildings;
    worker.postMessage(req, [t.ringOff.buffer, t.ringXY.buffer, t.height.buffer, t.heightSrc.buffer, t.osm.buffer, req.roads.pts.buffer, req.roads.off.buffer, req.roads.widths.buffer, req.roads.ranks.buffer]);
  });
}
