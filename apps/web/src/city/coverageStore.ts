import { create } from 'zustand';
import type { Zone } from '@sweep/engine';
import { cityUrl } from './data';
import { coverage } from './coverageClient';
import type { CoveragePlanResult, CoverageResponse, FleetSettings } from './coverage.worker';
import { BASELINE, specOf, useScenarios, type Scenario } from './scenario';
import { useCity } from './store';
import { DEFAULT_COSTS, type CostAssumptions } from './costModel';
import { canExtend, circleZone, polygonZone, rectZone, zoneProblem, type XY, type ZoneShape } from './zoneShape';

/** Headline numbers of a plan, summed over the vehicle routes actually driven (with a fleet, more than the single closed route it splits). */
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
  const distanceM = r.routes.reduce((a, v) => a + v.distanceM, 0);
  const serviceM = r.routes.reduce((a, v) => a + v.serviceM, 0);
  return {
    method: r.method,
    optimal: r.optimal,
    distanceM,
    serviceM,
    transitM: distanceM - serviceM,
    makespanS: r.routes.reduce((a, v) => Math.max(a, v.seconds), 0),
    vehicleSeconds: r.routes.reduce((a, v) => a + v.seconds, 0),
    vehiclesUsed: r.routes.filter((v) => v.arcs.length > 0).length,
  };
}

/** The active scenario (the baseline when none is selected). */
export function activeScenario(): Scenario {
  const sc = useScenarios.getState();
  return sc.scenarios.find((x) => x.id === sc.activeId) ?? BASELINE;
}

/** Inputs a plan actually uses: the panel's values with the scenario's plan overrides applied. */
export function effectiveInputs(s: { depot: number | null; fleet: FleetSettings; costs: CostAssumptions }, scenario: Scenario): { depot: number | null; fleet: FleetSettings; costs: CostAssumptions } {
  const o = scenario.plan;
  if (!o) return { depot: s.depot, fleet: s.fleet, costs: s.costs };
  return {
    depot: o.depot ?? s.depot,
    fleet: { ...s.fleet, ...(o.vehicles !== undefined ? { vehicles: o.vehicles } : {}), ...(o.shiftSeconds !== undefined ? { shiftSeconds: o.shiftSeconds } : {}) },
    costs: { ...s.costs, ...o.costs },
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
  /** Shape the next zone is drawn as. */
  zoneShape: ZoneShape;
  /** Points placed so far for the zone being drawn: first corner, centre, or outline vertices. */
  draft: XY[];
  /** Why the last point or the finished shape was refused while drawing. */
  zoneHint: string | null;
  zone: Zone | null;
  depot: number | null;
  /** Further depots (city node and vehicles), planned together with the main depot. */
  extraDepots: { node: number; vehicles: number }[];
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
  /** The panel's inputs planned on the baseline, and the active scenario (network and plan overrides) planned with the same zone. */
  comparison: { baseline: PlanSummary | { error: string }; scenario: PlanSummary | { error: string }; key: string } | null;
  comparing: boolean;
  compare: () => Promise<void>;
  setZoneShape: (shape: ZoneShape) => void;
  /** Places the next point of the zone being drawn; true when that click completed the zone. */
  addZonePoint: (x: number, y: number) => boolean;
  /** Closes the polygon being drawn; true when it was accepted. */
  finishZone: () => boolean;
  undoZonePoint: () => void;
  /** Drops an unfinished drawing; the last completed zone stays until a new one is finished. */
  cancelZone: () => void;
  setDepot: (n: number | null) => void;
  addExtraDepot: (node: number) => void;
  setExtraDepotVehicles: (i: number, vehicles: number) => void;
  removeExtraDepot: (i: number) => void;
  setDump: (n: number | null) => void;
  setRoadClasses: (c: string[] | null) => void;
  setDirection: (d: 'directed' | 'undirected') => void;
  setFleet: (f: Partial<FleetSettings>) => void;
  setCosts: (c: Partial<CostAssumptions>) => void;
  clear: () => void;
  run: () => Promise<void>;
}

/** Stable description of every input of a coverage plan, including the active scenario. */
export function coverageKey(s: Pick<CoverageState, 'zone' | 'depot' | 'extraDepots' | 'dump' | 'roadClasses' | 'direction' | 'fleet'>): string {
  const active = activeScenario();
  const plan = active.plan ? { ...active.plan, costs: undefined } : null; // cost assumptions do not change the plan itself
  return JSON.stringify([s.zone, s.depot, s.extraDepots, s.dump, s.roadClasses, s.direction, s.fleet, specOf(active).key, plan]);
}

let runToken = 0;

/** Two clicks this close (metres) finish a polygon: a double click on the last point. */
const FINISH_SNAP_M = 0.5;

export const useCoverage = create<CoverageState>((set, get) => ({
  zoneShape: 'rect',
  draft: [],
  zoneHint: null,
  zone: null,
  depot: null,
  extraDepots: [],
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
  setZoneShape: (zoneShape) => set({ zoneShape, draft: [], zoneHint: null }),
  addZonePoint: (x, y) => {
    const { zoneShape, draft } = get();
    const p: XY = [x, y];
    if (zoneShape === 'polygon') {
      const last = draft[draft.length - 1];
      if (last && Math.hypot(last[0] - x, last[1] - y) < FINISH_SNAP_M) return get().finishZone();
      if (!canExtend(draft, p)) {
        set({ zoneHint: 'That point would make the outline cross itself. Click somewhere else.' });
        return false;
      }
      set({ draft: [...draft, p], zoneHint: null });
      return false;
    }
    if (draft.length === 0) {
      set({ draft: [p], zoneHint: null });
      return false;
    }
    const z = zoneShape === 'rect' ? rectZone(draft[0]!, p) : circleZone(draft[0]!, p);
    const problem = zoneProblem(z);
    if (problem) {
      set({ zoneHint: problem });
      return false;
    }
    set({ zone: z, draft: [], zoneHint: null });
    return true;
  },
  finishZone: () => {
    const { zoneShape, draft } = get();
    if (zoneShape !== 'polygon') return false;
    const z = polygonZone(draft);
    const problem = zoneProblem(z);
    if (problem) {
      set({ zoneHint: problem });
      return false;
    }
    set({ zone: z, draft: [], zoneHint: null });
    return true;
  },
  undoZonePoint: () => set({ draft: get().draft.slice(0, -1), zoneHint: null }),
  cancelZone: () => set({ draft: [], zoneHint: null }),
  setDepot: (depot) => set({ depot }),
  addExtraDepot: (node) => {
    const s = get();
    if (node === s.depot || s.extraDepots.some((d) => d.node === node)) return;
    set({ extraDepots: [...s.extraDepots, { node, vehicles: 1 }] });
  },
  setExtraDepotVehicles: (i, vehicles) => set({ extraDepots: get().extraDepots.map((d, k) => (k === i ? { ...d, vehicles: Math.max(1, Math.min(20, Math.round(vehicles))) } : d)) }),
  removeExtraDepot: (i) => set({ extraDepots: get().extraDepots.filter((_, k) => k !== i) }),
  setDump: (dump) => set({ dump }),
  setRoadClasses: (roadClasses) => set({ roadClasses }),
  setDirection: (direction) => set({ direction }),
  setFleet: (f) => set({ fleet: { ...get().fleet, ...f } }),
  setCosts: (c) => set({ costs: { ...get().costs, ...c } }),
  clear: () => set({ draft: [], zoneHint: null, zone: null, depot: null, extraDepots: [], dump: null, result: null, resultKey: null, status: 'idle', error: null }),
  compare: async () => {
    const s = get();
    const active = activeScenario();
    const eff = effectiveInputs(s, active);
    if (!s.zone || s.depot === null || eff.depot === null) return;
    set({ comparing: true });
    const st = useCity.getState();
    const entry = st.index.find((c) => c.id === st.cityId);
    const key = coverageKey(s);
    const ask = async (scenario: ReturnType<typeof specOf>, depotNode: number, fleet: FleetSettings): Promise<PlanSummary | { error: string }> => {
      try {
        const res = await coverage.send<Extract<CoverageResponse, { op: 'plan' }>>({ op: 'plan', zone: s.zone!, roadClasses: s.roadClasses, direction: s.direction, scenario, depotNode, dumpNode: s.dump, fleet, extraDepots: s.extraDepots });
        return summarise(res.result);
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    };
    try {
      if (!entry) throw new Error('City not loaded.');
      await coverage.init(cityUrl(entry.file));
      const baseline = await ask(specOf(BASELINE), s.depot, s.fleet);
      const scenario = await ask(specOf(active), eff.depot, eff.fleet);
      set({ comparison: { baseline, scenario, key }, comparing: false });
    } catch (e) {
      set({ comparison: { baseline: { error: String(e) }, scenario: { error: String(e) }, key }, comparing: false });
    }
  },
  run: async () => {
    const s = get();
    const active = activeScenario();
    const eff = effectiveInputs(s, active);
    if (!s.zone || eff.depot === null) return;
    const token = ++runToken;
    set({ status: 'running', error: null });
    try {
      const st = useCity.getState();
      const entry = st.index.find((c) => c.id === st.cityId);
      if (!entry) throw new Error('City not loaded.');
      await coverage.init(cityUrl(entry.file));
      const key = coverageKey(s);
      const res = await coverage.send<Extract<CoverageResponse, { op: 'plan' }>>({
        op: 'plan',
        zone: s.zone,
        roadClasses: s.roadClasses,
        direction: s.direction,
        scenario: specOf(active),
        depotNode: eff.depot,
        dumpNode: s.dump,
        fleet: eff.fleet,
        extraDepots: s.extraDepots,
      });
      if (token !== runToken) return;
      set({ status: 'done', result: res.result, resultKey: key });
    } catch (e) {
      if (token !== runToken) return;
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
