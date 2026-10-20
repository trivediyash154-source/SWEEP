import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { Graph } from '@sweep/engine';
import { useWorkspace } from '../state/workspace';
import { useAuth } from '../state/auth';
import { api, ApiRequestError } from '../lib/api';
import { listLocalScenarios } from '../lib/storage';
import { BotanicalCursorField } from '../components/botanical/BotanicalCursorField';
import { CommandHeader } from './CommandHeader';
import { SimulationSection } from './SimulationSection';
import { ProjectionSection } from './ProjectionSection';
import { MathSection } from './MathSection';
import { LabSection } from './LabSection';
import { EditorSection } from './EditorSection';
import { ExportSection, HistorySection, VerificationSection } from './ReportSections';
import { RouteDataContext, useRouteData } from './useRouteData';
import { routeClock } from './routeClock';
import { scrollToSurface } from './surfaces';
import '../styles/workspace.css';

/** Account scenarios fetched from the server during this page session. */
const loadedRemote = new Set<string>();

/**
 * The SWEEP workspace: one long-form environment of connected surfaces that all
 * read the same authoritative result (see useRouteData). No sign-in is needed;
 * everything works locally, with the server engine used when it is reachable.
 */
export default function Workspace() {
  const ws = useWorkspace();
  const auth = useAuth();
  const { scenarioId } = useParams();
  const [search] = useSearchParams();
  const [loadError, setLoadError] = useState<string | null>(null);
  const data = useRouteData();

  // ---- load scenario from the URL ------------------------------------------
  useEffect(() => {
    const example = search.get('example');
    if (example && !scenarioId) {
      if (!(ws.ref?.kind === 'example' && ws.ref.id === example) && !ws.loadExample(example)) setLoadError(`There is no bundled example called "${example}". Choose one from the library in the editor.`);
      return;
    }
    if (!scenarioId) return;
    if (ws.ref?.id === scenarioId && ws.ref.kind !== 'remote') return;
    if (ws.ref?.id === scenarioId && ws.ref.kind === 'remote' && loadedRemote.has(scenarioId)) return;
    if (scenarioId.startsWith('local-')) {
      const s = listLocalScenarios().find((x) => x.id === scenarioId);
      if (s) ws.loadGraph(s.graph, { kind: 'local', id: s.id }, s.name);
      else setLoadError('That saved scenario is not on this device.');
      return;
    }
    if (auth.status === 'unknown' || auth.status === 'loading') return;
    api<{ id: string; name: string; graph: Graph }>(`/scenarios/${scenarioId}`)
      .then((s) => {
        setLoadError(null);
        loadedRemote.add(s.id);
        ws.loadGraph(s.graph, { kind: 'remote', id: s.id }, s.name);
      })
      .catch((e: ApiRequestError) => {
        if (useWorkspace.getState().ref?.kind === 'remote') useWorkspace.getState().loadExample('meridian-district');
        setLoadError(e.status === 401 ? 'Sign in to open this account scenario.' : e.status === 404 ? 'Scenario not found, or it belongs to another account.' : e.message);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioId, search, auth.status]);

  // Open straight into a solved, playing city.
  useEffect(() => {
    const st = useWorkspace.getState();
    if (!st.result && !st.optimizing && st.validation.ok) void st.runOptimize();
    return () => routeClock.pause();
  }, []);

  // ---- keyboard shortcuts --------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"], .dialog')) return;
      const st = useWorkspace.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        st.redo();
        return;
      }
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        void st.runOptimize();
        return;
      }
      if (mod || e.altKey) return;
      const inEditor = !!t.closest('#surface-editor');
      const map: Record<string, () => void> = {
        v: () => st.setTool('select'),
        a: () => st.setTool('add'),
        c: () => st.setTool('connect'),
        r: () => st.setTool('required'),
        o: () => st.setTool('oneway'),
        x: () => st.setTool('delete'),
        s: () => st.setTool('depot'),
        f: () => st.requestFit(),
        Escape: () => {
          st.setPendingConnect(null);
          st.select(null);
          st.clearInspect();
        },
        Delete: () => {
          if (st.selection?.type === 'vertex') st.removeVertex(st.selection.id);
          else if (st.selection?.type === 'edge') st.removeEdge(st.selection.id);
        },
        Backspace: () => map.Delete!(),
      };
      // Editing keys act only inside the editor surface; navigation keys work everywhere.
      const global: Record<string, () => void> = {
        p: () => {
          if (routeClock.playing) {
            routeClock.pause();
            st.setPlaying(false);
          } else {
            routeClock.play();
            st.setPlaying(true);
          }
        },
        m: () => scrollToSurface('mathematics'),
        e: () => scrollToSurface('editor'),
        Escape: map.Escape!,
      };
      const fn = (inEditor ? (map[e.key] ?? map[e.key.toLowerCase()]) : undefined) ?? global[e.key] ?? global[e.key.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <RouteDataContext.Provider value={data}>
      <div className="workspace">
        <BotanicalCursorField intensity={0.85} />
        <CommandHeader />
        <main id="main" className="ws-main">
          {loadError && (
            <div className="notice notice--warn ws-notice" role="alert">
              {loadError}
            </div>
          )}
          <SimulationSection />
          <ProjectionSection />
          <MathSection />
          <LabSection />
          <EditorSection />
          <VerificationSection />
          <HistorySection />
          <ExportSection />
          <footer className="ws-foot faint small">
            SWEEP · exact route intelligence · {data.graph.source?.attribution ? `Map data ${data.graph.source.attribution} (${data.graph.source.license}).` : 'Synthetic or user-drawn network.'}
          </footer>
        </main>
      </div>
    </RouteDataContext.Provider>
  );
}
