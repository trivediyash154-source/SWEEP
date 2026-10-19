import type { FleetRecord, Graph, Issue, OptimizationFailure, RoutingSettings, SingleRouteRecord } from './types.js';
import { solveChinesePostman } from './solve.js';
import { solveDirectedPostman } from './directed.js';
import { solveFleet } from './fleet.js';
import { isOneway } from './validate.js';

/** Defaults applied to missing routing settings. */
export const DEFAULT_ROUTING: Required<RoutingSettings> = {
  mode: 'undirected',
  twoWay: 'both',
  ignoreOneway: false,
  vehicles: 1,
  objective: 'balance',
  maxRouteLength: null,
};

export function resolveRouting(graph: Graph, override?: RoutingSettings): Required<RoutingSettings> {
  const merged = { ...DEFAULT_ROUTING, ...(graph.routing ?? {}), ...(override ?? {}) };
  return { ...merged, maxRouteLength: merged.maxRouteLength ?? null };
}

export type RoutingResult =
  | {
      ok: true;
      settings: Required<RoutingSettings>;
      single: SingleRouteRecord;
      /** Present when more than one vehicle was requested and the split succeeded. */
      fleet: FleetRecord | null;
      /** Why the fleet plan could not be produced (the single route is still valid). */
      fleetIssues: Issue[];
    }
  | OptimizationFailure;

/**
 * Solve with the scenario's routing settings: the exact undirected solver,
 * the exact directed/mixed solver, and (for more than one vehicle) the fleet
 * split on top of the certified single route. The undirected solver is never
 * used for a network with one-way streets unless the two-way relaxation is
 * requested explicitly.
 */
export function solveRouting(graph: Graph, override?: RoutingSettings, depotId?: string | null): RoutingResult {
  const settings = resolveRouting(graph, override);
  const depot = depotId ?? graph.depotId ?? null;
  const single =
    settings.mode === 'directed'
      ? solveDirectedPostman(graph, { depotId: depot, twoWay: settings.twoWay })
      : solveChinesePostman(graph, { depotId: depot, ignoreOneway: settings.ignoreOneway && graph.edges.some(isOneway) });
  if (!single.ok) return single;
  if (settings.vehicles === 1) return { ok: true, settings, single, fleet: null, fleetIssues: [] };
  const fleet = solveFleet(graph, {
    vehicles: settings.vehicles,
    mode: settings.mode,
    twoWay: settings.twoWay,
    ignoreOneway: settings.ignoreOneway,
    objective: settings.objective,
    maxRouteLength: settings.maxRouteLength,
    depotId: depot,
    base: single,
  });
  if (!fleet.ok) return { ok: true, settings, single, fleet: null, fleetIssues: fleet.validation.issues.filter((i) => i.severity === 'error') };
  return { ok: true, settings, single, fleet, fleetIssues: [] };
}
