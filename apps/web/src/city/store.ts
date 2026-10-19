import { create } from 'zustand';
import type { CityModel } from '@sweep/engine';
import type { CameraCommand, CityMeshes, PickResult } from './GeoCityScene';
import { DEFAULT_CITY, buildMeshesInWorker, fetchCity, fetchCityIndex, type CityIndexEntry } from './data';

export type CityMode = 'route' | 'coverage' | 'scenarios';

/** What the next click on the map selects. */
export type PickTarget = null | 'origin' | 'destination' | 'depot' | 'dump' | 'scenario-depot' | 'close-road' | 'make-oneway' | 'zone-a' | 'zone-b';

export interface LoadTimings {
  fetchMs: number;
  decodeMs: number;
  geometryMs: number;
  bytes: number;
}

interface CityState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  index: CityIndexEntry[];
  cityId: string;
  city: CityModel | null;
  meshes: CityMeshes | null;
  timings: LoadTimings | null;
  mode: CityMode;
  camera: { cmd: CameraCommand; nonce: number; frame?: { minX: number; minY: number; maxX: number; maxY: number } | null };
  hover: PickResult | null;
  selection: PickResult | null;
  pickTarget: PickTarget;
  showEstimates: boolean;
  load: (id?: string) => Promise<void>;
  setMode: (m: CityMode) => void;
  cameraCmd: (cmd: CameraCommand, frame?: { minX: number; minY: number; maxX: number; maxY: number } | null) => void;
  setHover: (p: PickResult | null) => void;
  select: (p: PickResult | null) => void;
  setPickTarget: (t: PickTarget) => void;
  setShowEstimates: (on: boolean) => void;
}

let loadToken = 0;

export const useCity = create<CityState>((set, get) => ({
  status: 'idle',
  error: null,
  index: [],
  cityId: DEFAULT_CITY,
  city: null,
  meshes: null,
  timings: null,
  mode: 'route',
  camera: { cmd: 'overview', nonce: 0 },
  hover: null,
  selection: null,
  pickTarget: 'origin',
  showEstimates: false,
  load: async (id) => {
    const token = ++loadToken;
    const cityId = id ?? get().cityId;
    set({ status: 'loading', error: null, cityId, meshes: null });
    try {
      const index = get().index.length ? get().index : await fetchCityIndex();
      const entry = index.find((c) => c.id === cityId);
      if (!entry) throw new Error(`No bundled city called "${cityId}".`);
      const { city, timings } = await fetchCity(entry);
      if (token !== loadToken) return;
      set({ index, city, status: 'ready', camera: { cmd: 'overview', nonce: get().camera.nonce + 1 } });
      const g0 = performance.now();
      const meshes = await buildMeshesInWorker(city);
      if (token !== loadToken) return;
      set({ meshes, timings: { ...timings, geometryMs: performance.now() - g0 } });
    } catch (e) {
      if (token !== loadToken) return;
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },
  setMode: (mode) => set({ mode, pickTarget: mode === 'route' ? 'origin' : mode === 'coverage' ? null : null }),
  cameraCmd: (cmd, frame) => set((s) => ({ camera: { cmd, nonce: s.camera.nonce + 1, frame: frame ?? null } })),
  setHover: (hover) => {
    const h = get().hover;
    if (h === hover) return;
    if (h && hover && h.kind === hover.kind && ('seg' in h ? h.seg === (hover as { seg?: number }).seg : 'node' in h ? h.node === (hover as { node?: number }).node : false)) return;
    set({ hover });
  },
  select: (selection) => set({ selection }),
  setPickTarget: (pickTarget) => set({ pickTarget }),
  setShowEstimates: (showEstimates) => set({ showEstimates }),
}));
