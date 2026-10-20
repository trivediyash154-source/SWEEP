import type { Graph, RoutingSettings } from '@sweep/engine';
import { readJson, writeJson } from './storage';

/**
 * Local experiment history: every optimisation run in this browser, with the
 * configuration and a graph snapshot so it can be reopened exactly. Stored in
 * localStorage only; nothing leaves the device.
 */
export interface ExperimentSummary {
  mode: 'undirected' | 'directed';
  problem: string;
  total: number;
  required: number;
  repeated: number;
  steps: number;
  optimal: boolean;
  checksPassed: number;
  checksTotal: number;
  vehicles: number;
  makespan: number | null;
  fleetTotal: number | null;
  vertexCount: number;
  edgeCount: number;
}

export interface Experiment {
  id: string;
  at: number;
  name: string;
  source: 'server' | 'browser';
  settings: Required<RoutingSettings>;
  summary: ExperimentSummary;
  /** Null when the network was too large to keep a copy. */
  graph: Graph | null;
}

const KEY = 'sweep.experiments.v1';
const MAX = 40;
const MAX_GRAPH_CHARS = 350_000;

export function listExperiments(): Experiment[] {
  const list = readJson<Experiment[]>(KEY, []);
  return Array.isArray(list) ? list.filter((x) => x && typeof x.id === 'string' && x.summary) : [];
}

export function recordExperiment(e: Omit<Experiment, 'graph'> & { graph: Graph }): void {
  const json = JSON.stringify(e.graph);
  const entry: Experiment = { ...e, graph: json.length <= MAX_GRAPH_CHARS ? e.graph : null };
  const list = [entry, ...listExperiments()].slice(0, MAX);
  if (!writeJson(KEY, list)) writeJson(KEY, list.slice(0, 10).map((x) => ({ ...x, graph: null })));
}

export function deleteExperiment(id: string): void {
  writeJson(KEY, listExperiments().filter((x) => x.id !== id));
}

/** Remove every SWEEP key from this browser's storage (scenarios, drafts, experiments, preferences). */
export function clearAllLocalData(): number {
  let removed = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sweep.')) keys.push(k);
    }
    for (const k of keys) {
      localStorage.removeItem(k);
      removed++;
    }
  } catch {
    /* storage unavailable */
  }
  return removed;
}
