import { create } from 'zustand';
import type { Zone } from '@sweep/engine';
import { cityUrl } from './data';
import { coverage } from './coverageClient';
import type { CoveragePlanResult, CoverageResponse, FleetSettings } from './coverage.worker';
import { specOf, useScenarios } from './scenario';
import { useCity } from './store';

export type RectZone = Extract<Zone, { kind: 'rect' }>;

/** Default fleet settings. Speeds are planning inputs the user sets, not measured values. */
export const DEFAULT_FLEET: FleetSettings = {
  vehicles: 1,
  objective: 'min-makespan',
  capacity: null,
  demandPerKm: 0,
  shiftSeconds: null,
  serviceSpeedKmh: 8,
  deadheadSpeedKmh: 20,
  dumpSeconds: 0,
};

interface CoverageState {
  cornerA: [number, number] | null;
  zone: RectZone | null;
  depot: number | null;
  dump: number | null;
  /** OSM highway classes to service; null = every class present. */
  roadClasses: string[] | null;
  direction: 'directed' | 'undirected';
  fleet: FleetSettings;
  status: 'idle' | 'running' | 'done' | 'error';
  error: string | null;
  result: CoveragePlanResult | null;
  /** Inputs the shown result was computed from (to flag stale results). */
  resultKey: string | null;
  setCorner: (which: 'a' | 'b', x: number, y: number) => void;
  setDepot: (n: number | null) => void;
  setDump: (n: number | null) => void;
  setRoadClasses: (c: string[] | null) => void;
  setDirection: (d: 'directed' | 'undirected') => void;
  setFleet: (f: Partial<FleetSettings>) => void;
  clear: () => void;
  run: () => Promise<void>;
}

/** Stable description of every input of a coverage plan, including the active scenario. */
export function coverageKey(s: Pick<CoverageState, 'zone' | 'depot' | 'dump' | 'roadClasses' | 'direction' | 'fleet'>): string {
  const sc = useScenarios.getState();
  const active = sc.scenarios.find((x) => x.id === sc.activeId);
  return JSON.stringify([s.zone, s.depot, s.dump, s.roadClasses, s.direction, s.fleet, active ? specOf(active).key : 'baseline']);
}

let runToken = 0;

export const useCoverage = create<CoverageState>((set, get) => ({
  cornerA: null,
  zone: null,
  depot: null,
  dump: null,
  roadClasses: null,
  direction: 'directed',
  fleet: DEFAULT_FLEET,
  status: 'idle',
  error: null,
  result: null,
  resultKey: null,
  setCorner: (which, x, y) => {
    if (which === 'a') set({ cornerA: [x, y], zone: null });
    else {
      const a = get().cornerA;
      if (!a) return;
      set({ zone: { kind: 'rect', minX: Math.min(a[0], x), minY: Math.min(a[1], y), maxX: Math.max(a[0], x), maxY: Math.max(a[1], y) } });
    }
  },
  setDepot: (depot) => set({ depot }),
  setDump: (dump) => set({ dump }),
  setRoadClasses: (roadClasses) => set({ roadClasses }),
  setDirection: (direction) => set({ direction }),
  setFleet: (f) => set({ fleet: { ...get().fleet, ...f } }),
  clear: () => set({ cornerA: null, zone: null, depot: null, dump: null, result: null, resultKey: null, status: 'idle', error: null }),
  run: async () => {
    const s = get();
    if (!s.zone || s.depot === null) return;
    const token = ++runToken;
    set({ status: 'running', error: null });
    try {
      const st = useCity.getState();
      const entry = st.index.find((c) => c.id === st.cityId);
      if (!entry) throw new Error('City not loaded.');
      await coverage.init(cityUrl(entry.file));
      const sc = useScenarios.getState();
      const active = sc.scenarios.find((x) => x.id === sc.activeId);
      const key = coverageKey(s);
      const res = await coverage.send<Extract<CoverageResponse, { op: 'plan' }>>({
        op: 'plan',
        zone: s.zone,
        roadClasses: s.roadClasses,
        direction: s.direction,
        scenario: active ? specOf(active) : { key: 'baseline', closed: [], oneway: [] },
        depotNode: s.depot,
        dumpNode: s.dump,
        fleet: s.fleet,
      });
      if (token !== runToken) return;
      set({ status: 'done', result: res.result, resultKey: key });
    } catch (e) {
      if (token !== runToken) return;
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
