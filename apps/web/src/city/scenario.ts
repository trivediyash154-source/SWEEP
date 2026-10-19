import { create } from 'zustand';
import type { ScenarioSpec } from './router.worker';

/**
 * Scenarios modify the REAL inputs of every computation: closed segments are
 * removed from the routing and coverage graphs; one-way overrides change the
 * permitted directions. The baseline (no changes) always exists.
 */
export interface Scenario {
  id: string;
  name: string;
  closed: number[];
  oneway: [number, 'forward' | 'reverse' | 'two-way'][];
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
    set({ scenarios: [...get().scenarios, { id, name: name ?? `Scenario ${n}`, closed: [...base.closed], oneway: [...base.oneway] }], activeId: id });
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
}));
