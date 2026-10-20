import type { Graph } from '@sweep/engine';
import { planSweep, type LngLatPair, type SweepFailure, type SweepPlan, type SweepSettings, type Zone } from './plan';

/** Runs the sweep plan off the main thread (exact coverage of a few km² can take seconds). */
export interface SweepRequest {
  id: number;
  graph: Graph;
  zone: Zone;
  depot: LngLatPair;
  settings: SweepSettings;
}
export type SweepResponse = { id: number; result: SweepPlan | SweepFailure } | { id: number; error: string };

self.onmessage = (ev: MessageEvent<SweepRequest>) => {
  const { id, graph, zone, depot, settings } = ev.data;
  try {
    (self as unknown as Worker).postMessage({ id, result: planSweep(graph, zone, depot, settings) } satisfies SweepResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies SweepResponse);
  }
};
