import { create } from 'zustand';
import { validateGraph, type Edge, type Graph, type OptimizationRecord, type ValidationReport } from '@sweep/engine';
import { EXAMPLES, getExample } from '@sweep/engine/examples';
import { edgePoints, polylineLength, vertexMap } from '../lib/geometry';
import { optimize, type EngineSource } from '../lib/engineClient';
import { api } from '../lib/api';
import type { OptimizationResult } from '@sweep/engine';
import { readJson, writeJson } from '../lib/storage';

export type Tool = 'select' | 'add' | 'connect' | 'required' | 'delete' | 'depot';
export type View = 'compose' | 'explain' | 'fly';
export type Selection = { type: 'vertex' | 'edge'; id: string } | null;
export type ScenarioRef = { kind: 'example' | 'local' | 'remote' | 'import' | 'blank'; id: string } | null;

export const EXPLAIN_STEPS = ['Original network', 'Degree analysis', 'Shortest paths', 'Minimum matching', 'Augmentation', 'Euler circuit', 'Verification'] as const;

interface WorkspaceState {
  graph: Graph;
  name: string;
  ref: ScenarioRef;
  dirty: boolean;
  validation: ValidationReport;
  lockedWeights: string[];
  selection: Selection;
  hover: Selection;
  /** vertices flagged by a hovered diagnostic */
  highlight: string[];
  setHighlight: (ids: string[]) => void;
  tool: Tool;
  pendingConnect: string | null;
  view: View;
  result: OptimizationRecord | null;
  resultGraph: Graph | null;
  resultSource: EngineSource | null;
  /** id of the stored run when the result was saved to the user's account */
  runId: string | null;
  runsNonce: number;
  showRun: (run: { id: string; graph: Graph; record: OptimizationRecord }) => void;
  stale: boolean;
  failure: ValidationReport | null;
  optimizing: boolean;
  error: string | null;
  explainStep: number;
  history: Graph[];
  future: Graph[];
  fitNonce: number;
  playing: boolean;
  speed: number;
  /** progress as drawn length along the route; mutated by the animation loop */
  progressNonce: number;

  loadGraph: (graph: Graph, ref: ScenarioRef, name?: string) => void;
  loadExample: (id: string) => boolean;
  setName: (name: string) => void;
  markSaved: (ref: ScenarioRef) => void;
  setTool: (t: Tool) => void;
  setView: (v: View) => void;
  select: (s: Selection) => void;
  setHover: (s: Selection) => void;
  addVertex: (x: number, y: number) => string;
  moveVertex: (id: string, x: number, y: number, commit: boolean) => void;
  beginMove: () => void;
  connect: (a: string, b: string) => string | null;
  setPendingConnect: (id: string | null) => void;
  updateEdge: (id: string, patch: Partial<Pick<Edge, 'weight' | 'required' | 'name'>>) => void;
  updateVertex: (id: string, patch: { label?: string }) => void;
  setAllRequired: (required: boolean) => void;
  removeVertex: (id: string) => void;
  removeEdge: (id: string) => void;
  setDepot: (id: string | null) => void;
  applyConnectorSuggestion: () => void;
  undo: () => void;
  redo: () => void;
  requestFit: () => void;
  runOptimize: () => Promise<void>;
  setExplainStep: (i: number) => void;
  setPlaying: (p: boolean) => void;
  setSpeed: (s: number) => void;
  clearResult: () => void;
}

const DRAFT_KEY = 'sweep.workspaceDraft.v1';

function computeLocked(graph: Graph): string[] {
  const vm = vertexMap(graph);
  return graph.edges.filter((e) => Math.round(polylineLength(edgePoints(e, vm))) !== e.weight).map((e) => e.id);
}

function nextId(prefix: string, taken: Set<string>): string {
  let i = taken.size;
  while (taken.has(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

const defaultExample = EXAMPLES.find((e) => e.id === 'old-town-grid') ?? EXAMPLES[0]!;

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

const init = initialState();

export const useWorkspace = create<WorkspaceState>((set, get) => {
  /** Apply a graph mutation with undo history, revalidation and staleness tracking. */
  const mutate = (fn: (g: Graph) => Graph, opts: { history?: boolean } = {}): void => {
    const s = get();
    const next = fn(s.graph);
    if (next === s.graph) return;
    const history = opts.history === false ? s.history : [...s.history.slice(-99), s.graph];
    set({
      graph: next,
      history,
      future: opts.history === false ? s.future : [],
      dirty: true,
      validation: validateGraph(next),
      stale: s.result !== null,
      failure: null,
    });
    persistDraft({ graph: next, name: get().name, ref: get().ref });
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
    validation: validateGraph(init.graph),
    lockedWeights: computeLocked(init.graph),
    selection: null,
    hover: null,
    highlight: [],
    setHighlight: (highlight) => set({ highlight }),
    tool: 'select',
    pendingConnect: null,
    view: 'compose',
    result: null,
    resultGraph: null,
    resultSource: null,
    runId: null,
    runsNonce: 0,
    stale: false,
    failure: null,
    optimizing: false,
    error: null,
    explainStep: 0,
    history: [],
    future: [],
    fitNonce: 0,
    playing: false,
    speed: 1,
    progressNonce: 0,

    loadGraph: (graph, ref, name) => {
      const g = structuredClone(graph);
      set({
        graph: g,
        ref,
        name: name ?? graph.name ?? 'Untitled network',
        dirty: false,
        validation: validateGraph(g),
        lockedWeights: computeLocked(g),
        selection: null,
        pendingConnect: null,
        result: null,
        resultGraph: null,
        resultSource: null,
        runId: null,
        stale: false,
        failure: null,
        error: null,
        explainStep: 0,
        history: [],
        future: [],
        fitNonce: get().fitNonce + 1,
        playing: false,
        view: get().view === 'fly' ? 'compose' : get().view,
      });
      persistDraft({ graph: g, name: get().name, ref });
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
    setView: (view) => set({ view, playing: false }),
    select: (selection) => set({ selection }),
    setHover: (hover) => set({ hover }),

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
        { history: false },
      );
      if (commit) set({ validation: validateGraph(get().graph) });
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
          const next = { ...e, ...patch };
          if (!next.name) delete next.name;
          return next;
        }),
      }));
    },
    updateVertex: (id, patch) => {
      mutate((g) => ({
        ...g,
        vertices: g.vertices.map((v) => {
          if (v.id !== id) return v;
          const next = { ...v, ...patch };
          if (!next.label) delete next.label;
          return next;
        }),
      }));
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
    undo: () => {
      const s = get();
      const prev = s.history[s.history.length - 1];
      if (!prev) return;
      set({ graph: prev, history: s.history.slice(0, -1), future: [s.graph, ...s.future], validation: validateGraph(prev), stale: s.result !== null, dirty: true });
      persistDraft({ graph: prev, name: s.name, ref: s.ref });
    },
    redo: () => {
      const s = get();
      const next = s.future[0];
      if (!next) return;
      set({ graph: next, future: s.future.slice(1), history: [...s.history, s.graph], validation: validateGraph(next), stale: s.result !== null, dirty: true });
      persistDraft({ graph: next, name: s.name, ref: s.ref });
    },
    requestFit: () => set({ fitNonce: get().fitNonce + 1 }),

    runOptimize: async () => {
      const s = get();
      if (s.optimizing) return;
      set({ optimizing: true, error: null, playing: false });
      const graphSnapshot = structuredClone(s.graph);
      try {
        let result: OptimizationResult;
        let source: EngineSource;
        let runId: string | null = null;
        if (s.ref?.kind === 'remote' && !s.dirty) {
          // Saved account scenario: run on the server and store the run for later.
          const d = await api<{ run: { id: string } | null; result: OptimizationResult }>(`/scenarios/${s.ref.id}/runs`, { method: 'POST', body: { depotId: graphSnapshot.depotId ?? null } });
          result = d.result;
          source = 'server';
          runId = d.run?.id ?? null;
        } else {
          ({ result, source } = await optimize(graphSnapshot, graphSnapshot.depotId ?? null));
        }
        // Ignore the answer if the network changed while computing.
        if (get().graph !== s.graph) {
          set({ optimizing: false });
          return;
        }
        if (result.ok) {
          set({ result, resultGraph: graphSnapshot, resultSource: source, runId, runsNonce: get().runsNonce + 1, failure: null, stale: false, optimizing: false, explainStep: 0 });
        } else {
          set({ failure: result.validation, result: null, resultGraph: null, optimizing: false, stale: false });
        }
      } catch (err) {
        set({ optimizing: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    showRun: (run) =>
      set({ result: run.record, resultGraph: run.graph, resultSource: 'server', runId: run.id, stale: JSON.stringify(run.graph.edges) !== JSON.stringify(get().graph.edges), failure: null, playing: false, explainStep: 0 }),
    setExplainStep: (i) => set({ explainStep: Math.max(0, Math.min(EXPLAIN_STEPS.length - 1, i)) }),
    setPlaying: (playing) => set({ playing }),
    setSpeed: (speed) => set({ speed }),
    clearResult: () => set({ result: null, resultGraph: null, failure: null, stale: false, playing: false }),
  };
});
