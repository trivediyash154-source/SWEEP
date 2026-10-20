import { create } from 'zustand';
import type { ScenarioSpec } from './router.worker';
import type { CostAssumptions } from './costModel';

/**
 * Operational changes a scenario makes to coverage planning. A field that is
 * absent keeps the value set in the Coverage & fleet panel; a present field
 * replaces it whenever this scenario is planned.
 */
export interface PlanOverrides {
  depot?: number;
  vehicles?: number;
  /** null = no shift limit. */
  shiftSeconds?: number | null;
  costs?: Partial<CostAssumptions>;
}

/**
 * Scenarios modify the REAL inputs of every computation: closed segments are
 * removed from the routing and coverage graphs; one-way overrides change the
 * permitted directions; plan overrides change the depot, fleet and cost
 * assumptions of coverage plans. The baseline (no changes) always exists.
 */
export interface Scenario {
  id: string;
  name: string;
  closed: number[];
  oneway: [number, 'forward' | 'reverse' | 'two-way'][];
  plan?: PlanOverrides;
}

/** Number of operational overrides a scenario sets (each cost assumption counts once). */
export function overrideCount(s: Scenario): number {
  const p = s.plan;
  if (!p) return 0;
  return (p.depot !== undefined ? 1 : 0) + (p.vehicles !== undefined ? 1 : 0) + (p.shiftSeconds !== undefined ? 1 : 0) + Object.keys(p.costs ?? {}).length;
}

export const BASELINE: Scenario = { id: 'baseline', name: 'Baseline (as mapped)', closed: [], oneway: [] };

export function specOf(s: Scenario): ScenarioSpec {
  const closed = [...s.closed].sort((a, b) => a - b);
  const oneway = [...s.oneway].sort((a, b) => a[0] - b[0]);
  return { key: `${closed.join(',')}|${oneway.map(([g, d]) => `${g}${d[0]}`).join(',')}`, closed, oneway };
}

interface ScenarioState {
  scenarios: Scenario[];
  activeId: string;
  active: () => Scenario;
  setActive: (id: string) => void;
  create: (name?: string) => string;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  toggleClosed: (seg: number) => void;
  setOneway: (seg: number, dir: 'forward' | 'reverse' | 'two-way' | null) => void;
  /** Sets or (with undefined) removes plan overrides on the active scenario; on the baseline this creates a scenario first. */
  setPlan: (patch: { [K in keyof Omit<PlanOverrides, 'costs'>]?: PlanOverrides[K] | undefined } & { costs?: { [K in keyof CostAssumptions]?: CostAssumptions[K] | undefined } }) => void;
}

export const useScenarios = create<ScenarioState>((set, get) => ({
  scenarios: [BASELINE],
  activeId: 'baseline',
  active: () => get().scenarios.find((s) => s.id === get().activeId) ?? BASELINE,
  setActive: (activeId) => set({ activeId }),
  create: (name) => {
    const n = get().scenarios.length;
    const id = `scn-${Date.now().toString(36)}-${n}`;
    const base = get().active();
    const copy: Scenario = { id, name: name ?? `Scenario ${n}`, closed: [...base.closed], oneway: [...base.oneway], ...(base.plan ? { plan: { ...base.plan, ...(base.plan.costs ? { costs: { ...base.plan.costs } } : {}) } } : {}) };
    set({ scenarios: [...get().scenarios, copy], activeId: id });
    return id;
  },
  rename: (id, name) => set({ scenarios: get().scenarios.map((s) => (s.id === id ? { ...s, name } : s)) }),
  remove: (id) => {
    if (id === 'baseline') return;
    set({ scenarios: get().scenarios.filter((s) => s.id !== id), activeId: get().activeId === id ? 'baseline' : get().activeId });
  },
  toggleClosed: (seg) => {
    let id = get().activeId;
    if (id === 'baseline') id = get().create('Road closure');
    set({ scenarios: get().scenarios.map((s) => (s.id === id ? { ...s, closed: s.closed.includes(seg) ? s.closed.filter((x) => x !== seg) : [...s.closed, seg] } : s)) });
  },
  setOneway: (seg, dir) => {
    let id = get().activeId;
    if (id === 'baseline') id = get().create('Direction change');
    set({ scenarios: get().scenarios.map((s) => (s.id === id ? { ...s, oneway: dir === null ? s.oneway.filter(([g]) => g !== seg) : [...s.oneway.filter(([g]) => g !== seg), [seg, dir]] } : s)) });
  },
  setPlan: (patch) => {
    let id = get().activeId;
    if (id === 'baseline') id = get().create('Operations change');
    const merge = (cur: PlanOverrides | undefined): PlanOverrides | undefined => {
      const next: Record<string, unknown> = { ...cur };
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'costs') continue;
        if (v === undefined) delete next[k];
        else next[k] = v;
      }
      if (patch.costs) {
        const costs: Record<string, unknown> = { ...cur?.costs };
        for (const [k, v] of Object.entries(patch.costs)) {
          if (v === undefined) delete costs[k];
          else costs[k] = v;
        }
        if (Object.keys(costs).length) next.costs = costs;
        else delete next.costs;
      }
      return Object.keys(next).length ? (next as PlanOverrides) : undefined;
    };
    set({
      scenarios: get().scenarios.map((s) => {
        if (s.id !== id) return s;
        const plan = merge(s.plan);
        const { plan: _old, ...rest } = s;
        return plan ? { ...rest, plan } : rest;
      }),
    });
  },
}));
