import { create } from 'zustand';
import type { AlgorithmId, Objective, ProfileId } from '@sweep/engine';
import { router } from './routerClient';
import type { AlgorithmRun, RouterResponse } from './router.worker';
import { specOf, useScenarios } from './scenario';
import { cityUrl } from './data';
import { useCity } from './store';

export const ALL_ALGORITHMS: AlgorithmId[] = ['dijkstra', 'astar', 'bidirectional', 'alt', 'ch'];

/** Replay head shared with the renderer (read every frame; no React state). */
export const replayHead = { current: 0 };
/** Route travel head for the drawn route (metres). */
export const routeHead = { current: Infinity };

interface RouteState {
  origin: number | null;
  destination: number | null;
  profile: ProfileId;
  objective: Objective;
  algorithms: AlgorithmId[];
  running: boolean;
  error: string | null;
  runs: AlgorithmRun[] | null;
  meta: Omit<Extract<RouterResponse, { op: 'route' }>, 'id' | 'ok' | 'op' | 'runs'> | null;
  /** Which algorithm's route and search trace are drawn. */
  active: AlgorithmId | null;
  replaying: boolean;
  reach: Extract<RouterResponse, { op: 'reach' }>['reach'] | null;
  reachAssumptions: string[];
  reachRunning: boolean;
  scenarioKey: string;
  setOrigin: (n: number | null) => void;
  setDestination: (n: number | null) => void;
  swap: () => void;
  setProfile: (p: ProfileId) => void;
  setObjective: (o: Objective) => void;
  toggleAlgorithm: (a: AlgorithmId) => void;
  setActive: (a: AlgorithmId) => void;
  run: () => Promise<void>;
  runReach: () => Promise<void>;
  clearReach: () => void;
  replay: () => void;
  stopReplay: () => void;
  clear: () => void;
}

let raf = 0;

/** Points the camera at the query: the bounding box of both endpoints and the found route. */
function frameRoute(origin: number, destination: number, runs: AlgorithmRun[]): void {
  const city = useCity.getState().city;
  if (!city) return;
  let minX = Math.min(city.nodeX[origin]!, city.nodeX[destination]!);
  let maxX = Math.max(city.nodeX[origin]!, city.nodeX[destination]!);
  let minY = Math.min(city.nodeY[origin]!, city.nodeY[destination]!);
  let maxY = Math.max(city.nodeY[origin]!, city.nodeY[destination]!);
  for (const n of runs.find((r) => r.result.found)?.result.nodePath ?? []) {
    minX = Math.min(minX, city.nodeX[n]!);
    maxX = Math.max(maxX, city.nodeX[n]!);
    minY = Math.min(minY, city.nodeY[n]!);
    maxY = Math.max(maxY, city.nodeY[n]!);
  }
  const pad = Math.max(150, (maxX - minX + maxY - minY) * 0.12);
  useCity.getState().cameraCmd('frame', { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad });
}

async function ensureRouter(): Promise<void> {
  const st = useCity.getState();
  const entry = st.index.find((c) => c.id === st.cityId);
  if (!entry) throw new Error('City not loaded.');
  await router.init(cityUrl(entry.file));
}

export const useRoute = create<RouteState>((set, get) => ({
  origin: null,
  destination: null,
  profile: 'car',
  objective: 'time',
  algorithms: [...ALL_ALGORITHMS],
  running: false,
  error: null,
  runs: null,
  meta: null,
  active: null,
  replaying: false,
  reach: null,
  reachAssumptions: [],
  reachRunning: false,
  scenarioKey: 'baseline',
  setOrigin: (origin) => {
    set({ origin, runs: null, reach: null });
    if (origin !== null && get().destination !== null) void get().run();
  },
  setDestination: (destination) => {
    set({ destination, runs: null });
    if (destination !== null && get().origin !== null) void get().run();
  },
  swap: () => {
    const { origin, destination } = get();
    set({ origin: destination, destination: origin, runs: null, reach: null });
    if (origin !== null && destination !== null) void get().run();
  },
  setProfile: (profile) => {
    set({ profile, runs: null, reach: null });
    if (get().origin !== null && get().destination !== null) void get().run();
  },
  setObjective: (objective) => {
    set({ objective, runs: null });
    if (get().origin !== null && get().destination !== null) void get().run();
  },
  toggleAlgorithm: (a) => {
    const cur = get().algorithms;
    const next = cur.includes(a) ? cur.filter((x) => x !== a) : ALL_ALGORITHMS.filter((x) => x === a || cur.includes(x));
    if (next.length === 0) return;
    set({ algorithms: next });
  },
  setActive: (active) => {
    set({ active });
    get().replay();
  },
  run: async () => {
    const { origin, destination, profile, objective, algorithms } = get();
    if (origin === null || destination === null) return;
    const scenario = specOf(useScenarios.getState().active());
    set({ running: true, error: null });
    try {
      await ensureRouter();
      const res = await router.send<Extract<RouterResponse, { op: 'route' }>>({ op: 'route', profile, objective, origin, destination, algorithms, scenario, repeat: 5 });
      // Ignore stale answers (inputs changed while computing).
      const cur = get();
      if (cur.origin !== origin || cur.destination !== destination || cur.profile !== profile || cur.objective !== objective) return;
      const { runs, ...meta } = res;
      const active = cur.active && runs.some((r) => r.result.algorithm === cur.active) ? cur.active : (runs.find((r) => r.result.algorithm === 'astar') ?? runs[0])?.result.algorithm ?? null;
      frameRoute(origin, destination, runs);
      set({ runs, meta: { graphBuildMs: meta.graphBuildMs, graphStats: meta.graphStats, assumptions: meta.assumptions, maxSpeedKmh: meta.maxSpeedKmh, endpoints: meta.endpoints }, active, running: false, scenarioKey: scenario.key });
      get().replay();
    } catch (e) {
      set({ running: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
  runReach: async () => {
    const { origin, profile } = get();
    if (origin === null) return;
    set({ reachRunning: true, error: null });
    try {
      await ensureRouter();
      const res = await router.send<Extract<RouterResponse, { op: 'reach' }>>({ op: 'reach', profile, origin, thresholds: [300, 600, 900], scenario: specOf(useScenarios.getState().active()) });
      set({ reach: res.reach, reachAssumptions: res.assumptions, reachRunning: false });
    } catch (e) {
      set({ reachRunning: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
  clearReach: () => set({ reach: null }),
  replay: () => {
    cancelAnimationFrame(raf);
    const run = get().runs?.find((r) => r.result.algorithm === get().active);
    if (!run?.trace) return;
    const total = run.trace.count;
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || total === 0) {
      replayHead.current = total;
      routeHead.current = Infinity;
      set({ replaying: false });
      return;
    }
    // Reveal the recorded expansions over ~2.2 s (longer searches reveal more per frame), then draw the route.
    const duration = 2200;
    const t0 = performance.now();
    replayHead.current = 0;
    routeHead.current = 0;
    set({ replaying: true });
    const routeLen = run.result.distanceM;
    const step = (now: number) => {
      const f = Math.min(1, (now - t0) / duration);
      replayHead.current = Math.floor(f * total);
      if (f < 1) {
        raf = requestAnimationFrame(step);
        return;
      }
      replayHead.current = total;
      const r0 = performance.now();
      const drive = (n2: number) => {
        const g = Math.min(1, (n2 - r0) / 1200);
        routeHead.current = g * routeLen;
        if (g < 1) raf = requestAnimationFrame(drive);
        else {
          routeHead.current = Infinity;
          set({ replaying: false });
        }
      };
      raf = requestAnimationFrame(drive);
    };
    raf = requestAnimationFrame(step);
  },
  stopReplay: () => {
    cancelAnimationFrame(raf);
    const run = get().runs?.find((r) => r.result.algorithm === get().active);
    replayHead.current = run?.trace?.count ?? 0;
    routeHead.current = Infinity;
    set({ replaying: false });
  },
  clear: () => {
    cancelAnimationFrame(raf);
    replayHead.current = 0;
    routeHead.current = Infinity;
    set({ origin: null, destination: null, runs: null, meta: null, active: null, reach: null, replaying: false, error: null });
  },
}));
