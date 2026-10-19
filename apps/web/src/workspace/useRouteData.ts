import { createContext, useContext, useEffect, useMemo } from 'react';
import type { Graph, RouteStep } from '@sweep/engine';
import { useWorkspace } from '../state/workspace';
import { usePrefs } from '../state/prefs';
import { buildTrack, type RouteTrack } from '../lib/routeTrack';
import { buildDistrict, type District } from '../three/district';
import { analysisSteps, highlightFor, type AnalysisStep, type Highlight } from '../lib/analysis';
import { graphBounds } from '../lib/geometry';
import { vehicleColor, type ThemeName } from '../lib/spectral';
import { routeClock } from './routeClock';

export interface RouteData {
  /** Graph the visualisations draw (the solved snapshot when the result is current). */
  graph: Graph;
  theme: ThemeName;
  /** One entry per vehicle (or the single route). */
  stepsList: RouteStep[][];
  colors: Array<string | null>;
  tracks2d: RouteTrack[];
  district: District;
  tracks3d: RouteTrack[];
  highlight: Highlight;
  steps: AnalysisStep[];
  total: number;
  fresh: boolean;
}

/**
 * Everything the 3D city, the projection and the readouts draw is derived here
 * from the same authoritative result, so they can never disagree.
 */
export function useRouteData(): RouteData {
  const graphLive = useWorkspace((s) => s.graph);
  const result = useWorkspace((s) => s.result);
  const fleet = useWorkspace((s) => s.fleet);
  const resultGraph = useWorkspace((s) => s.resultGraph);
  const stale = useWorkspace((s) => s.stale);
  const step = useWorkspace((s) => s.analysisStep);
  const selection = useWorkspace((s) => s.selection);
  const focusPair = useWorkspace((s) => s.focusPair);
  const inspectPath = useWorkspace((s) => s.inspectPath);
  const theme = usePrefs((s) => s.theme) as ThemeName;

  const fresh = !!result && !!resultGraph && !stale;
  const graph = fresh ? resultGraph! : graphLive;
  const stepsList = useMemo<RouteStep[][]>(() => {
    if (!fresh || !result) return [];
    if (fleet) return fleet.routes.map((r) => r.steps);
    return [result.route.steps];
  }, [fresh, result, fleet]);
  const colors = useMemo(() => (fleet && fresh ? fleet.routes.map((_, i) => vehicleColor(i, theme)) : [null]), [fleet, fresh, theme]);
  const district = useMemo(() => buildDistrict(graph), [graph]);
  const tracks3d = useMemo(() => stepsList.map((s) => buildTrack(graph, s, { laneWidth: district.laneW })), [graph, stepsList, district]);
  const tracks2d = useMemo(() => {
    const b = graphBounds(graph);
    const lane = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.0035;
    return stepsList.map((s) => buildTrack(graph, s, { laneWidth: lane }));
  }, [graph, stepsList]);
  const focusVertex = selection?.type === 'vertex' ? selection.id : null;
  const highlight = useMemo(
    () => highlightFor(fresh ? result : null, step, { vertex: step ? focusVertex : null, pair: focusPair, inspectPath }),
    [fresh, result, step, focusVertex, focusPair, inspectPath],
  );
  const steps = useMemo(() => (fresh && result ? analysisSteps(result) : []), [fresh, result]);
  const total = tracks3d.reduce((m, t) => Math.max(m, t.total), 0);

  // Keep the shared playback clock in step with the route being shown.
  useEffect(() => {
    routeClock.setTotal(total);
    routeClock.reset();
    useWorkspace.getState().setPlaying(false);
  }, [total, tracks3d]);

  return { graph, theme, stepsList, colors, tracks2d, district, tracks3d, highlight, steps, total, fresh };
}


export const RouteDataContext = createContext<RouteData | null>(null);

/** Read the route data computed once by the workspace. */
export function useRoute(): RouteData {
  const v = useContext(RouteDataContext);
  if (!v) throw new Error('useRoute outside RouteDataContext');
  return v;
}
