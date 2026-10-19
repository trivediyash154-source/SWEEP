import { create } from 'zustand';
import {
  isOneway,
  resolveRouting,
  shortestPathBetween,
  validateGraph,
  type Edge,
  type FleetRecord,
  type Graph,
  type Issue,
  type RoutingSettings,
  type SingleRouteRecord,
  type ValidationReport,
} from '@sweep/engine';
import { EXAMPLES, getExample } from '@sweep/engine/examples';
import { edgePoints, polylineLength, vertexMap } from '../lib/geometry';
import { route, type EngineSource } from '../lib/engineClient';
import { api } from '../lib/api';
import { readJson, writeJson, newId } from '../lib/storage';
import { normalizeRecord, type StepId } from '../lib/analysis';
import { recordExperiment } from '../lib/experiments';

export type Tool = 'select' | 'add' | 'connect' | 'required' | 'oneway' | 'delete' | 'depot';
export type StageMode = '3d' | '2d';
export type Selection = { type: 'vertex' | 'edge'; id: string } | null;
export type ScenarioRef = { kind: 'example' | 'local' | 'remote' | 'import' | 'acquired' | 'blank'; id: string } | null;
export type CameraCommand = 'reset' | 'top' | 'focus-route' | 'focus-node' | 'follow';

export type RoutingOk = { settings: Required<RoutingSettings>; single: SingleRouteRecord; fleet: FleetRecord | null; fleetIssues: Issue[] };

interface WorkspaceState {
  graph: Graph;
  name: string;
  ref: ScenarioRef;
  dirty: boolean;
  /** True once intersections or streets changed since the network was loaded (routing settings and renames do not count). */
  networkEdited: boolean;
  validation: ValidationReport;
  lockedWeights: string[];
  selection: Selection;
  hover: Selection;
  /** Vertices flagged by a hovered diagnostic. */
  highlight: string[];
  setHighlight: (ids: string[]) => void;
  tool: Tool;
  pendingConnect: string | null;
  stage: StageMode;

  /** Single-vehicle record (always present after a successful run). */
  result: SingleRouteRecord | null;
  fleet: FleetRecord | null;
  fleetIssues: Issue[];
  resultSettings: Required<RoutingSettings> | null;
  resultGraph: Graph | null;
  resultSource: EngineSource | null;
  runId: string | null;
  stale: boolean;
  failure: ValidationReport | null;
  optimizing: boolean;
  error: string | null;
  autoSolve: boolean;

  /** Algorithm investigation */
  analysisStep: StepId | null;
  focusPair: number | null;
  inspectPath: { from: string; to: string; distance: number; vertexIds: string[]; edgeIds: string[] } | null;

  /** Playback: which fleet vehicle the camera and readouts follow (0 = all / single). */
  activeVehicle: number;
  playing: boolean;
  speed: number;
  follow: boolean;
  camera: { cmd: CameraCommand; nonce: number };

  history: Graph[];
  future: Graph[];
  fitNonce: number;

  loadGraph: (graph: Graph, ref: ScenarioRef, name?: string) => void;
  loadExample: (id: string) => boolean;
  setName: (name: string) => void;
  markSaved: (ref: ScenarioRef) => void;
  setTool: (t: Tool) => void;
  setStage: (m: StageMode) => void;
  select: (s: Selection) => void;
  setHover: (s: Selection) => void;
  addVertex: (x: number, y: number) => string;
  moveVertex: (id: string, x: number, y: number, commit: boolean) => void;
  beginMove: () => void;
  connect: (a: string, b: string) => string | null;
  setPendingConnect: (id: string | null) => void;
  updateEdge: (id: string, patch: Partial<Pick<Edge, 'weight' | 'required' | 'name' | 'oneway' | 'reverseWeight'>>) => void;
  reverseEdge: (id: string) => void;
  updateVertex: (id: string, patch: { label?: string }) => void;
  setAllRequired: (required: boolean) => void;
  removeVertex: (id: string) => void;
  removeEdge: (id: string) => void;
  setDepot: (id: string | null) => void;
  applyConnectorSuggestion: () => void;
  setRouting: (patch: RoutingSettings) => void;
  undo: () => void;
  redo: () => void;
  requestFit: () => void;
  runOptimize: () => Promise<void>;
  setAutoSolve: (on: boolean) => void;
  showRun: (run: { id: string; graph: Graph; record: SingleRouteRecord; fleet?: FleetRecord | null; settings?: Required<RoutingSettings> }) => void;
  setAnalysisStep: (s: StepId | null) => void;
  setFocusPair: (i: number | null) => void;
  inspectBetween: (from: string, to: string) => void;
  clearInspect: () => void;
  setActiveVehicle: (v: number) => void;
  setPlaying: (p: boolean) => void;
  setSpeed: (s: number) => void;
  setFollow: (f: boolean) => void;
  cameraCommand: (cmd: CameraCommand) => void;
  clearResult: () => void;
}

const DRAFT_KEY = 'sweep.workspaceDraft.v1';

export function routingOf(graph: Graph): Required<RoutingSettings> {
  return resolveRouting(graph);
}

/** Validation consistent with the scenario's routing mode. */
export function validateFor(graph: Graph): ValidationReport {
  const r = routingOf(graph);
  const hasOneway = graph.edges.some(isOneway);
  return validateGraph(graph, { onewayPolicy: r.mode === 'directed' ? 'directed' : r.ignoreOneway && hasOneway ? 'ignore' : 'reject' });
}

function computeLocked(graph: Graph): string[] {
  const vm = vertexMap(graph);
  // Map data and imported networks keep their measured lengths.
  if (graph.source && graph.source.kind !== 'user' && graph.source.kind !== 'example') return graph.edges.map((e) => e.id);
  return graph.edges.filter((e) => Math.round(polylineLength(edgePoints(e, vm))) !== e.weight).map((e) => e.id);
}

function nextId(prefix: string, taken: Set<string>): string {
  let i = taken.size;
  while (taken.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

export const DEFAULT_EXAMPLE_ID = 'meridian-district';
const defaultExample = EXAMPLES.find((e) => e.id === DEFAULT_EXAMPLE_ID) ?? EXAMPLES[0]!;

function initialState(): { graph: Graph; name: string; ref: ScenarioRef } {
  const draft = readJson<{ graph: Graph; name: string; ref: ScenarioRef } | null>(DRAFT_KEY, null);
  if (draft && draft.graph && Array.isArray(draft.graph.vertices) && Array.isArray(draft.graph.edges)) return draft;
  return { graph: structuredClone(defaultExample.graph), name: defaultExample.title, ref: { kind: 'example', id: defaultExample.id } };
}

let draftTimer: ReturnType<typeof setTimeout> | null = null;
function persistDraft(s: { graph: Graph; name: string; ref: ScenarioRef }): void {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => writeJson(DRAFT_KEY, { graph: s.graph, name: s.name, ref: s.ref }), 400);
}

let autoTimer: ReturnType<typeof setTimeout> | null = null;

const init = initialState();

export const useWorkspace = create<WorkspaceState>((set, get) => {
  const scheduleAuto = (): void => {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      const s = get();
      if (s.autoSolve && s.validation.ok && !s.optimizing) void s.runOptimize();
    }, 450);
  };

  /** Apply a graph mutation with undo history, revalidation and staleness tracking. */
  const mutate = (fn: (g: Graph) => Graph, opts: { history?: boolean; auto?: boolean } = {}): void => {
    const s = get();
    const next = fn(s.graph);
    if (next === s.graph) return;
    const history = opts.history === false ? s.history : [...s.history.slice(-99), s.graph];
    set({
      graph: next,
      history,
      future: opts.history === false ? s.future : [],
      dirty: true,
      networkEdited: s.networkEdited || next.vertices !== s.graph.vertices || next.edges !== s.graph.edges,
      validation: validateFor(next),
      stale: s.result !== null,
      failure: null,
      inspectPath: null,
    });
    persistDraft({ graph: next, name: get().name, ref: get().ref });
    if (opts.auto !== false) scheduleAuto();
  };

  const withAutoLengths = (g: Graph, vertexIds: Set<string>): Graph => {
    const locked = new Set(get().lockedWeights);
    const vm = vertexMap(g);
    return {
      ...g,
      edges: g.edges.map((e) => {
        if (locked.has(e.id) || !(vertexIds.has(e.u) || vertexIds.has(e.v))) return e;
        return { ...e, weight: Math.max(0, Math.round(polylineLength(edgePoints(e, vm)))) };
      }),
    };
  };

  return {
    graph: init.graph,
    name: init.name,
    ref: init.ref,
    dirty: false,
    networkEdited: false,
    validation: validateFor(init.graph),
    lockedWeights: computeLocked(init.graph),
    selection: null,
    hover: null,
    highlight: [],
    setHighlight: (highlight) => set({ highlight }),
    tool: 'select',
    pendingConnect: null,
    stage: '3d',
    result: null,
    fleet: null,
    fleetIssues: [],
    resultSettings: null,
    resultGraph: null,
    resultSource: null,
    runId: null,
    stale: false,
    failure: null,
    optimizing: false,
    error: null,
    autoSolve: readJson<boolean>('sweep.autoSolve', true),
    analysisStep: null,
    focusPair: null,
    inspectPath: null,
    activeVehicle: 0,
    playing: false,
    speed: 1,
    follow: false,
    camera: { cmd: 'reset', nonce: 0 },
    history: [],
    future: [],
    fitNonce: 0,

    loadGraph: (graph, ref, name) => {
      const g = structuredClone(graph);
      set({
        graph: g,
        ref,
        name: name ?? graph.name ?? 'Untitled network',
        dirty: false,
        networkEdited: false,
        validation: validateFor(g),
        lockedWeights: computeLocked(g),
        selection: null,
        hover: null,
        pendingConnect: null,
        result: null,
        fleet: null,
        fleetIssues: [],
        resultSettings: null,
        resultGraph: null,
        resultSource: null,
        runId: null,
        stale: false,
        failure: null,
        error: null,
        analysisStep: null,
        focusPair: null,
        inspectPath: null,
        activeVehicle: 0,
        history: [],
        future: [],
        fitNonce: get().fitNonce + 1,
        playing: false,
        follow: false,
        camera: { cmd: 'reset', nonce: get().camera.nonce + 1 },
      });
      persistDraft({ graph: g, name: get().name, ref });
      if (get().validation.ok) void get().runOptimize();
    },
    loadExample: (id) => {
      const ex = getExample(id);
      if (!ex) return false;
      get().loadGraph(ex.graph, { kind: 'example', id }, ex.title);
      return true;
    },
    setName: (name) => {
      set({ name, dirty: true });
      persistDraft({ graph: get().graph, name, ref: get().ref });
    },
    markSaved: (ref) => {
      set({ ref, dirty: false });
      persistDraft({ graph: get().graph, name: get().name, ref });
    },
    setTool: (tool) => set({ tool, pendingConnect: null }),
    setStage: (stage) => set({ stage }),
    select: (selection) => set({ selection }),
    setHover: (hover) => {
      const cur = get().hover;
      if (cur?.id === hover?.id && cur?.type === hover?.type) return;
      set({ hover });
    },

    addVertex: (x, y) => {
      const taken = new Set(get().graph.vertices.map((v) => v.id));
      const id = nextId('v', taken);
      mutate((g) => ({ ...g, vertices: [...g.vertices, { id, x: Math.round(x), y: Math.round(y) }] }));
      set({ selection: { type: 'vertex', id } });
      return id;
    },
    beginMove: () => {
      const s = get();
      set({ history: [...s.history.slice(-99), s.graph], future: [] });
    },
    moveVertex: (id, x, y, commit) => {
      mutate(
        (g) =>
          withAutoLengths(
            { ...g, vertices: g.vertices.map((v) => (v.id === id ? { ...v, x: Math.round(x), y: Math.round(y) } : v)) },
            new Set([id]),
          ),
        { history: false, auto: commit },
      );
    },
    connect: (a, b) => {
      if (a === b) return null;
      const g = get().graph;
      const taken = new Set(g.edges.map((e) => e.id));
      const id = nextId('e', taken);
      const vm = vertexMap(g);
      const pa = vm.get(a);
      const pb = vm.get(b);
      if (!pa || !pb) return null;
      const weight = Math.max(1, Math.round(Math.hypot(pa.x - pb.x, pa.y - pb.y)));
      mutate((gr) => ({ ...gr, edges: [...gr.edges, { id, u: a, v: b, weight, required: true }] }));
      set({ selection: { type: 'edge', id } });
      return id;
    },
    setPendingConnect: (pendingConnect) => set({ pendingConnect }),
    updateEdge: (id, patch) => {
      if (patch.weight !== undefined && !get().lockedWeights.includes(id)) set({ lockedWeights: [...get().lockedWeights, id] });
      mutate((g) => ({
        ...g,
        edges: g.edges.map((e) => {
          if (e.id !== id) return e;
          const next: Edge = { ...e, ...patch };
          if (!next.name) delete next.name;
          if (!next.oneway) delete next.oneway;
          if (next.directed) delete next.directed;
          if (next.reverseWeight === undefined || next.oneway) delete next.reverseWeight;
          return next;
        }),
      }));
    },
    reverseEdge: (id) =>
      mutate((g) => ({
        ...g,
        edges: g.edges.map((e) => (e.id === id ? { ...e, u: e.v, v: e.u, ...(e.shape ? { shape: [...e.shape].reverse() } : {}) } : e)),
      })),
    updateVertex: (id, patch) => {
      mutate(
        (g) => ({
          ...g,
          vertices: g.vertices.map((v) => {
            if (v.id !== id) return v;
            const next = { ...v, ...patch };
            if (!next.label) delete next.label;
            return next;
          }),
        }),
        { auto: false },
      );
    },
    setAllRequired: (required) => mutate((g) => ({ ...g, edges: g.edges.map((e) => ({ ...e, required })) })),
    removeVertex: (id) => {
      mutate((g) => ({
        ...g,
        vertices: g.vertices.filter((v) => v.id !== id),
        edges: g.edges.filter((e) => e.u !== id && e.v !== id),
        ...(g.depotId === id ? { depotId: null } : {}),
      }));
      set({ selection: null });
    },
    removeEdge: (id) => {
      mutate((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== id) }));
      set({ selection: null });
    },
    setDepot: (id) => mutate((g) => ({ ...g, depotId: id })),
    applyConnectorSuggestion: () => {
      const ids = new Set(get().validation.connectorSuggestion?.edgeIds ?? []);
      if (ids.size === 0) return;
      mutate((g) => ({ ...g, edges: g.edges.map((e) => (ids.has(e.id) ? { ...e, required: true } : e)) }));
    },
    setRouting: (patch) => mutate((g) => ({ ...g, routing: { ...(g.routing ?? {}), ...patch } })),
    undo: () => {
      const s = get();
      const prev = s.history[s.history.length - 1];
      if (!prev) return;
      set({ graph: prev, history: s.history.slice(0, -1), future: [s.graph, ...s.future], validation: validateFor(prev), stale: s.result !== null, dirty: true, networkEdited: s.networkEdited || prev.vertices !== s.graph.vertices || prev.edges !== s.graph.edges, inspectPath: null });
      persistDraft({ graph: prev, name: s.name, ref: s.ref });
      scheduleAuto();
    },
    redo: () => {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      set({ graph: next, future: s.future.slice(1), history: [...s.history, s.graph], validation: validateFor(next), stale: s.result !== null, dirty: true, networkEdited: s.networkEdited || next.vertices !== s.graph.vertices || next.edges !== s.graph.edges, inspectPath: null });
      persistDraft({ graph: next, name: s.name, ref: s.ref });
      scheduleAuto();
    },
    requestFit: () => set({ fitNonce: get().fitNonce + 1 }),

    runOptimize: async () => {
      const s = get();
      if (s.optimizing) return;
      set({ optimizing: true, error: null });
      const graphSnapshot = structuredClone(s.graph);
      const settings = routingOf(graphSnapshot);
      const depotId = graphSnapshot.depotId ?? null;
      try {
        let res: Awaited<ReturnType<typeof route>>['result'];
        let source: EngineSource;
        let runId: string | null = null;
        if (s.ref?.kind === 'remote' && !s.dirty) {
          // Saved account scenario: run on the server and store the run for later.
          const d = await api<{ run: { id: string } | null; result: unknown; routing?: unknown }>(`/scenarios/${s.ref.id}/runs`, { method: 'POST', body: { depotId, settings } });
          res = (d.routing ?? d.result) as typeof res;
          source = 'server';
          runId = d.run?.id ?? null;
        } else {
          ({ result: res, source } = await route(graphSnapshot, depotId, settings));
        }
        // Ignore the answer if the network changed while computing; the newer edit schedules its own run.
        if (get().graph !== s.graph) {
          set({ optimizing: false });
          if (get().autoSolve && get().validation.ok) scheduleAuto();
          return;
        }
        if (res.ok) {
          const single = normalizeRecord(res.single);
          set({
            result: single,
            fleet: res.fleet,
            fleetIssues: res.fleetIssues,
            resultSettings: res.settings,
            resultGraph: graphSnapshot,
            resultSource: source,
            runId,
            failure: null,
            stale: false,
            optimizing: false,
            activeVehicle: res.fleet && get().activeVehicle > res.fleet.routes.length ? 0 : get().activeVehicle,
          });
          recordExperiment({
            id: newId('run'),
            at: Date.now(),
            name: get().name,
            source,
            settings: res.settings,
            graph: graphSnapshot,
            summary: {
              mode: single.mode,
              problem: single.algorithm.problem,
              total: single.route.totalDistance,
              required: single.route.requiredDistance,
              repeated: single.route.repeatedDistance,
              steps: single.route.steps.length,
              optimal: single.algorithm.optimal,
              checksPassed: single.checks.filter((c) => c.passed).length,
              checksTotal: single.checks.length,
              vehicles: res.settings.vehicles,
              makespan: res.fleet?.makespan ?? null,
              fleetTotal: res.fleet?.totalDistance ?? null,
              vertexCount: graphSnapshot.vertices.length,
              edgeCount: graphSnapshot.edges.length,
            },
          });
        } else {
          set({ failure: res.validation, result: null, fleet: null, fleetIssues: [], resultGraph: null, optimizing: false, stale: false });
        }
      } catch (err) {
        set({ optimizing: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    setAutoSolve: (autoSolve) => {
      writeJson('sweep.autoSolve', autoSolve);
      set({ autoSolve });
      if (autoSolve && get().stale) scheduleAuto();
    },
    showRun: (run) =>
      set({
        result: normalizeRecord(run.record),
        fleet: run.fleet ?? null,
        fleetIssues: [],
        resultSettings: run.settings ?? routingOf(run.graph),
        resultGraph: run.graph,
        resultSource: 'server',
        runId: run.id,
        stale: JSON.stringify(run.graph.edges) !== JSON.stringify(get().graph.edges),
        failure: null,
        playing: false,
      }),
    setAnalysisStep: (analysisStep) => set({ analysisStep, focusPair: null }),
    setFocusPair: (focusPair) => set({ focusPair }),
    inspectBetween: (from, to) => {
      const g = get().resultGraph ?? get().graph;
      const directed = (get().resultSettings ?? routingOf(g)).mode === 'directed';
      const p = shortestPathBetween(g, from, to, directed);
      set({ inspectPath: p ? { from, to, ...p } : null });
    },
    clearInspect: () => set({ inspectPath: null }),
    setActiveVehicle: (activeVehicle) => set({ activeVehicle }),
    setPlaying: (playing) => set({ playing }),
    setSpeed: (speed) => set({ speed }),
    setFollow: (follow) => set({ follow }),
    cameraCommand: (cmd) => set({ camera: { cmd, nonce: get().camera.nonce + 1 }, follow: cmd === 'follow' }),
    clearResult: () => set({ result: null, fleet: null, resultGraph: null, failure: null, stale: false, playing: false }),
  };
});
