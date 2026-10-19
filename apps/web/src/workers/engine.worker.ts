/// <reference lib="webworker" />
import { solveChinesePostman, solveFleet, solveRouting, type Graph, type RoutingSettings, type SingleRouteRecord } from '@sweep/engine';

type Msg =
  | { id: number; op?: 'optimize'; graph: Graph; depotId: string | null }
  | { id: number; op: 'route'; graph: Graph; depotId: string | null; settings?: RoutingSettings }
  | { id: number; op: 'fleetSweep'; graph: Graph; depotId: string | null; settings: RoutingSettings; base: SingleRouteRecord; ks: number[] };

self.onmessage = (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  const post = (data: unknown) => (self as unknown as Worker).postMessage(data);
  try {
    if (m.op === 'route') post({ id: m.id, ok: true, result: solveRouting(m.graph, m.settings, m.depotId) });
    else if (m.op === 'fleetSweep') {
      const points = m.ks.map((k) => {
        const r = solveFleet(m.graph, {
          vehicles: k,
          mode: m.settings.mode,
          twoWay: m.settings.twoWay,
          ignoreOneway: m.settings.ignoreOneway,
          objective: m.settings.objective,
          maxRouteLength: m.settings.maxRouteLength,
          depotId: m.depotId,
          base: m.base,
        });
        return r.ok
          ? { k, ok: true, makespan: r.makespan, total: r.totalDistance, lowerBound: r.lowerBound.value, active: r.activeVehicles, ratioBound: r.algorithm.ratioBound }
          : { k, ok: false, issue: r.validation.issues.find((i) => i.severity === 'error')?.message ?? 'Failed' };
      });
      post({ id: m.id, ok: true, result: points });
    } else post({ id: m.id, ok: true, result: solveChinesePostman(m.graph, { depotId: m.depotId }) });
  } catch (err) {
    post({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
