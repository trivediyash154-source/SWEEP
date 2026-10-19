/// <reference lib="webworker" />
import { decodeCityBundle, profileAssumptions, reachability, RoutingEngine, validateRoute, type AlgorithmId, type CityModel, type Objective, type ProfileId, type RouteResult, type ValidationCheck } from '@sweep/engine';

/**
 * Point-to-point routing worker. Every algorithm in a comparison runs on the
 * same RoutingEngine (same turn-expanded graph, same profile, same scenario,
 * same cost function). Runtimes come from the engine (median of untraced runs,
 * performance.now); traces are recorded in a separate run, in the real settle
 * order; every route is checked by the independent validator.
 */

export interface ScenarioSpec {
  key: string;
  closed: number[];
  oneway: [number, 'forward' | 'reverse' | 'two-way'][];
}

export type RouterRequest =
  | { id: number; op: 'init'; url: string }
  | { id: number; op: 'route'; profile: ProfileId; objective: Objective; origin: number; destination: number; algorithms: AlgorithmId[]; scenario: ScenarioSpec; repeat: number }
  | { id: number; op: 'reach'; profile: ProfileId; origin: number; thresholds: number[]; scenario: ScenarioSpec };

export interface AlgorithmRun {
  result: RouteResult;
  validation: { ok: boolean; checks: ValidationCheck[] };
  trace: { arcs: Int32Array; cost: Float64Array; side: Uint8Array; count: number } | null;
}

export type RouterResponse =
  | { id: number; ok: true; op: 'init'; ms: number }
  | { id: number; ok: true; op: 'route'; runs: AlgorithmRun[]; graphBuildMs: number; graphStats: { allowedArcs: number; transitions: number; deniedArcs: Record<string, number> }; assumptions: string[]; maxSpeedKmh: number; endpoints: { originOut: number; destinationIn: number } }
  | { id: number; ok: true; op: 'reach'; reach: { thresholdsS: number[]; entryS: Float64Array; exitS: Float64Array; levels: { thresholdS: number; nodes: number; lengthM: number; fullArcs: number; partialArcs: number }[]; settled: number; runtimeMs: number }; assumptions: string[] }
  | { id: number; ok: false; error: string };

let city: CityModel | null = null;
const engines = new Map<string, RoutingEngine>();

function engineFor(profile: ProfileId, scenario: ScenarioSpec): RoutingEngine {
  const key = `${profile}|${scenario.key}`;
  let e = engines.get(key);
  if (!e) {
    if (engines.size > 8) engines.delete(engines.keys().next().value!);
    e = new RoutingEngine(city!, profile, { closedSegments: scenario.closed, onewayOverrides: new Map(scenario.oneway) });
    engines.set(key, e);
  }
  return e;
}

const post = (msg: RouterResponse, transfer: Transferable[] = []): void => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (ev: MessageEvent<RouterRequest>) => {
  const req = ev.data;
  try {
    if (req.op === 'init') {
      const t0 = performance.now();
      const res = await fetch(req.url);
      if (!res.ok) throw new Error(`City data unavailable (HTTP ${res.status}).`);
      city = decodeCityBundle(await res.json());
      engines.clear();
      post({ id: req.id, ok: true, op: 'init', ms: performance.now() - t0 });
      return;
    }
    if (!city) throw new Error('Router not initialised.');
    if (req.op === 'route') {
      const fresh = !engines.has(`${req.profile}|${req.scenario.key}`);
      const engine = engineFor(req.profile, req.scenario);
      const q = { origin: req.origin, destination: req.destination, objective: req.objective };
      const runs: AlgorithmRun[] = [];
      const transfer: Transferable[] = [];
      for (const alg of req.algorithms) {
        const { result, trace } = engine.query(alg, q, { repeat: req.repeat, trace: true });
        const validation = validateRoute(city, engine.graph, q, result);
        const t = trace ? { arcs: trace.arcs.slice(0, trace.count), cost: trace.cost.slice(0, trace.count), side: trace.side.slice(0, trace.count), count: trace.count } : null;
        if (t) transfer.push(t.arcs.buffer, t.cost.buffer, t.side.buffer);
        runs.push({ result, validation, trace: t });
      }
      post(
        {
          id: req.id,
          ok: true,
          op: 'route',
          runs,
          graphBuildMs: fresh ? engine.buildMs : 0,
          graphStats: engine.graph.stats,
          assumptions: profileAssumptions(req.profile),
          maxSpeedKmh: engine.graph.maxSpeedMs * 3.6,
          endpoints: {
            originOut: engine.graph.nodeOutOff[req.origin + 1]! - engine.graph.nodeOutOff[req.origin]!,
            destinationIn: engine.graph.nodeInOff[req.destination + 1]! - engine.graph.nodeInOff[req.destination]!,
          },
        },
        transfer,
      );
      return;
    }
    if (req.op === 'reach') {
      const engine = engineFor(req.profile, req.scenario);
      const r = reachability(engine.graph, req.origin, req.thresholds);
      const reach = {
        thresholdsS: r.thresholdsS,
        entryS: r.entryS,
        exitS: r.exitS,
        levels: r.levels.map((l) => ({ thresholdS: l.thresholdS, nodes: l.nodes, lengthM: l.lengthM, fullArcs: l.fullArcs.length, partialArcs: l.partialArcs.length })),
        settled: r.settled,
        runtimeMs: r.runtimeMs,
      };
      post({ id: req.id, ok: true, op: 'reach', reach, assumptions: profileAssumptions(req.profile) }, [r.entryS.buffer, r.exitS.buffer]);
    }
  } catch (e) {
    post({ id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
