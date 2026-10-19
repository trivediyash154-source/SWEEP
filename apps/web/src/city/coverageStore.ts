import { create } from 'zustand';
import type { Zone } from '@sweep/engine';
import { cityUrl } from './data';
import { coverage } from './coverageClient';
import type { CoveragePlanResult, CoverageResponse, FleetSettings } from './coverage.worker';
import { specOf, useScenarios, type Scenario } from './scenario';
import { useCity } from './store';
import { DEFAULT_COSTS, type CostAssumptions } from './costModel';

export type RectZone = Extract<Zone, { kind: 'rect' }>;
export type CircleZone = Extract<Zone, { kind: 'circle' }>;
export type DrawnZone = RectZone | CircleZone;

/** Bounding box of a drawn zone (city metres). */
export function zoneBox(z: DrawnZone): { minX: number; minY: number; maxX: number; maxY: number } {
  return z.kind === 'rect' ? { minX: z.minX, minY: z.minY, maxX: z.maxX, maxY: z.maxY } : { minX: z.cx - z.r, minY: z.cy - z.r, maxX: z.cx + z.r, maxY: z.cy + z.r };
}

/** Human description of a drawn zone, with its area. */
export function zoneLabel(z: DrawnZone, fmt: (m: number) => string): string {
  if (z.kind === 'circle') return `radius ${fmt(z.r)} · ${((Math.PI * z.r * z.r) / 1e6).toFixed(2)} km²`;
  const w = z.maxX - z.minX;
  const h = z.maxY - z.minY;
  return `${fmt(w)} × ${fmt(h)} · ${((w * h) / 1e6).toFixed(2)} km²`;
}

/** Headline numbers of a plan, for scenario comparison. */
export interface PlanSummary {
  method: CoveragePlanResult['method'];
  optimal: boolean;
  distanceM: number;
  serviceM: number;
  transitM: number;
  /** When the last vehicle is back. */
  makespanS: number;
  /** Sum of vehicle working time. */
  vehicleSeconds: number;
  vehiclesUsed: number;
}

export function summarise(r: CoveragePlanResult): PlanSummary {
  return {
    method: r.method,
    optimal: r.optimal,
    distanceM: r.routes.reduce((a, v) => a + v.distanceM, 0),
    serviceM: r.totals.serviceM,
    transitM: r.routes.reduce((a, v) => a + v.distanceM, 0) - r.totals.serviceM,
    makespanS: r.routes.reduce((a, v) => Math.max(a, v.seconds), 0),
    vehicleSeconds: r.routes.reduce((a, v) => a + v.seconds, 0),
    vehiclesUsed: r.routes.filter((v) => v.arcs.length > 0).length,
  };
}

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
  zoneShape: 'rect' | 'circle';
  zone: DrawnZone | null;
  depot: number | null;
  dump: number | null;
  /** OSM highway classes to service; null = every class present. */
  roadClasses: string[] | null;
  direction: 'directed' | 'undirected';
  fleet: FleetSettings;
  /** Operating-cost assumptions (user inputs; never measured values). */
  costs: CostAssumptions;
  status: 'idle' | 'running' | 'done' | 'error';
  error: string | null;
  result: CoveragePlanResult | null;
  /** Inputs the shown result was computed from (to flag stale results). */
  resultKey: string | null;
  /** Same inputs planned on the baseline and on the active scenario. */
  comparison: { baseline: PlanSummary | { error: string }; scenario: PlanSummary | { error: string }; key: string } | null;
  comparing: boolean;
  compare: () => Promise<void>;
  setCorner: (which: 'a' | 'b', x: number, y: number) => void;
  setZoneShape: (s: 'rect' | 'circle') => void;
  setDepot: (n: number | null) => void;
  setDump: (n: number | null) => void;
  setRoadClasses: (c: string[] | null) => void;
  setDirection: (d: 'directed' | 'undirected') => void;
  setFleet: (f: Partial<FleetSettings>) => void;
  setCosts: (c: Partial<CostAssumptions>) => void;
  clear: () => void;
  run: () => Promise<void>;
}

/** Stable description of every input of a coverage plan, including the active scenario. */
export function coverageKey(s: Pick<CoverageState, 'zone' | 'depot' | 'dump' | 'roadClasses' | 'direction' | 'fleet'>): string {
  const sc = useScenarios.getState();
  const active = sc.scenarios.find((x) => x.id === sc.activeId);
  return JSON.stringify([s.zone, s.depot, s.dump, s.roadClasses, s.direction, s.fleet, active ? specOf(active).key : 'baseline', active?.ops ?? null]);
}

/** Depot and fleet in effect under a scenario: its operational overrides on top of the plan's own inputs. */
export function effectiveInputs(s: Pick<CoverageState, 'depot' | 'fleet'>, scenario: Scenario | undefined): { depot: number | null; fleet: FleetSettings } {
  return { depot: scenario?.ops?.depot ?? s.depot, fleet: scenario?.ops?.vehicles ? { ...s.fleet, vehicles: scenario.ops.vehicles } : s.fleet };
}

let runToken = 0;

export const useCoverage = create<CoverageState>((set, get) => ({
  cornerA: null,
  zoneShape: 'rect',
  zone: null,
  depot: null,
  dump: null,
  roadClasses: null,
  direction: 'directed',
  fleet: DEFAULT_FLEET,
  costs: DEFAULT_COSTS,
  status: 'idle',
  error: null,
  result: null,
  resultKey: null,
  comparison: null,
  comparing: false,
  setCorner: (which, x, y) => {
    if (which === 'a') set({ cornerA: [x, y], zone: null });
    else {
      const a = get().cornerA;
      if (!a) return;
      if (get().zoneShape === 'circle') set({ zone: { kind: 'circle', cx: a[0], cy: a[1], r: Math.max(1, Math.hypot(x - a[0], y - a[1])) } });
      else set({ zone: { kind: 'rect', minX: Math.min(a[0], x), minY: Math.min(a[1], y), maxX: Math.max(a[0], x), maxY: Math.max(a[1], y) } });
    }
  },
  setZoneShape: (zoneShape) => set({ zoneShape, cornerA: null, zone: null }),
  setDepot: (depot) => set({ depot }),
  setDump: (dump) => set({ dump }),
  setRoadClasses: (roadClasses) => set({ roadClasses }),
  setDirection: (direction) => set({ direction }),
  setFleet: (f) => set({ fleet: { ...get().fleet, ...f } }),
  setCosts: (c) => set({ costs: { ...get().costs, ...c } }),
  clear: () => set({ cornerA: null, zone: null, depot: null, dump: null, result: null, resultKey: null, status: 'idle', error: null }),
  compare: async () => {
    const s = get();
    if (!s.zone || s.depot === null) return;
    set({ comparing: true });
    const st = useCity.getState();
    const entry = st.index.find((c) => c.id === st.cityId);
    const sc = useScenarios.getState();
    const active = sc.scenarios.find((x) => x.id === sc.activeId);
    const key = coverageKey(s);
    const ask = async (scenario: ReturnType<typeof specOf>, inputs: { depot: number | null; fleet: FleetSettings }): Promise<PlanSummary | { error: string }> => {
      try {
        if (inputs.depot === null) throw new Error('No depot.');
        const res = await coverage.send<Extract<CoverageResponse, { op: 'plan' }>>({ op: 'plan', zone: s.zone!, roadClasses: s.roadClasses, direction: s.direction, scenario, depotNode: inputs.depot, dumpNode: s.dump, fleet: inputs.fleet });
        return summarise(res.result);
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    };
    try {
      if (!entry) throw new Error('City not loaded.');
      await coverage.init(cityUrl(entry.file));
      const baseline = await ask({ key: 'baseline', closed: [], oneway: [] }, { depot: s.depot, fleet: s.fleet });
      const scenario = await ask(active ? specOf(active) : { key: 'baseline', closed: [], oneway: [] }, effectiveInputs(s, active));
      set({ comparison: { baseline, scenario, key }, comparing: false });
    } catch (e) {
      set({ comparison: { baseline: { error: String(e) }, scenario: { error: String(e) }, key }, comparing: false });
    }
  },
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
      const eff = effectiveInputs(s, active);
      const res = await coverage.send<Extract<CoverageResponse, { op: 'plan' }>>({
        op: 'plan',
        zone: s.zone,
        roadClasses: s.roadClasses,
        direction: s.direction,
        scenario: active ? specOf(active) : { key: 'baseline', closed: [], oneway: [] },
        depotNode: eff.depot!,
        dumpNode: s.dump,
        fleet: eff.fleet,
      });
      if (token !== runToken) return;
      set({ status: 'done', result: res.result, resultKey: key });
    } catch (e) {
      if (token !== runToken) return;
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
