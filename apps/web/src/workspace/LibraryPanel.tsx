import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { EXAMPLES } from '@sweep/engine/examples';
import { useWorkspace } from '../state/workspace';
import { useAuth } from '../state/auth';
import { api } from '../lib/api';
import { deleteLocalScenario, listLocalScenarios, type LocalScenario } from '../lib/storage';
import { toast } from '../state/toasts';
import { Icon } from '../components/Icon';
import { ImportDialog } from './ImportDialog';

interface RemoteScenario {
  id: string;
  name: string;
  updatedAt: number;
  vertexCount: number;
  edgeCount: number;
}

const CATEGORY_LABEL: Record<string, string> = { learn: 'Learn', core: 'Core', 'edge-case': 'Edge case', scale: 'Scale', 'real-data': 'Real map' };

export function LibraryPanel({ refreshKey }: { refreshKey: number }) {
  const ws = useWorkspace();
  const auth = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'examples' | 'saved'>('examples');
  const [local, setLocal] = useState<LocalScenario[]>([]);
  const [remote, setRemote] = useState<RemoteScenario[] | null>(null);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    setLocal(listLocalScenarios());
    if (auth.status === 'signed-in') {
      api<RemoteScenario[]>('/scenarios')
        .then((r) => {
          setRemote(r);
          setRemoteError(null);
        })
        .catch((e: Error) => setRemoteError(e.message));
    } else setRemote(null);
  }, [auth.status, refreshKey, tab]);

  const removeRemote = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`Delete “${name}” from your account? This cannot be undone.`)) return;
    try {
      await api(`/scenarios/${id}`, { method: 'DELETE' });
      setRemote((r) => r?.filter((x) => x.id !== id) ?? null);
      toast.success('Scenario deleted');
    } catch (e) {
      toast.error('Could not delete scenario', (e as Error).message);
    }
  };

  const duplicateRemote = async (id: string): Promise<void> => {
    try {
      const d = await api<{ id: string; name: string }>(`/scenarios/${id}/duplicate`, { method: 'POST', body: {} });
      toast.success('Scenario duplicated', d.name);
      setRemote(await api<RemoteScenario[]>('/scenarios'));
    } catch (e) {
      toast.error('Could not duplicate scenario', (e as Error).message);
    }
  };

  return (
    <aside className="library" aria-label="Library">
      <div className="segmented library__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'examples'} onClick={() => setTab('examples')}>
          Examples
        </button>
        <button type="button" role="tab" aria-selected={tab === 'saved'} onClick={() => setTab('saved')}>
          Saved
        </button>
      </div>

      {tab === 'examples' && (
        <div role="tabpanel" aria-label="Example networks" className="library__panel">
        <ul className="library__list">
          {EXAMPLES.map((ex) => {
            const active = ws.ref?.kind === 'example' && ws.ref.id === ex.id;
            return (
              <li key={ex.id}>
                <button
                  type="button"
                  className={`lib-item${active ? ' is-active' : ''}`}
                  onClick={() => {
                    ws.loadExample(ex.id);
                    navigate(`/lab?example=${ex.id}`, { replace: true });
                  }}
                  data-testid={`example-${ex.id}`}
                >
                  <span className="lib-item__top">
                    <span className="lib-item__title">{ex.title}</span>
                    <span className={`lib-item__cat lib-item__cat--${ex.category}`}>{CATEGORY_LABEL[ex.category]}</span>
                  </span>
                  <span className="lib-item__sub">{ex.subtitle}</span>
                </button>
              </li>
            );
          })}
        </ul>
        </div>
      )}

      {tab === 'saved' && (
        <div role="tabpanel" aria-label="Saved scenarios" className="library__saved">
          <h3 className="panel-subtitle">On this device</h3>
          {local.length === 0 ? (
            <p className="faint small">Nothing saved locally yet. Use Save in the header.</p>
          ) : (
            <ul className="library__list">
              {local.map((s) => (
                <li key={s.id} className="lib-row">
                  <button type="button" className="lib-item" onClick={() => { ws.loadGraph(s.graph, { kind: 'local', id: s.id }, s.name); navigate(`/lab/${s.id}`, { replace: true }); }}>
                    <span className="lib-item__title">{s.name}</span>
                    <span className="lib-item__sub">
                      {s.graph.vertices.length} intersections · {new Date(s.updatedAt).toLocaleDateString()}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon btn--sm"
                    aria-label={`Delete ${s.name}`}
                    onClick={() => {
                      if (!window.confirm(`Delete “${s.name}” from this device?`)) return;
                      deleteLocalScenario(s.id);
                      setLocal(listLocalScenarios());
                    }}
                  >
                    <Icon name="delete" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h3 className="panel-subtitle">In your account</h3>
          {auth.status === 'unavailable' ? (
            <p className="faint small">Accounts need the SWEEP server, which is not reachable from this build. Local saving still works.</p>
          ) : auth.status !== 'signed-in' ? (
            <p className="faint small">
              <Link to="/signin">Sign in</Link> to keep scenarios and optimisation runs in your account.
            </p>
          ) : remoteError ? (
            <p className="field__error">{remoteError}</p>
          ) : remote === null ? (
            <p className="faint small">Loading…</p>
          ) : remote.length === 0 ? (
            <p className="faint small">No scenarios in your account yet.</p>
          ) : (
            <ul className="library__list">
              {remote.map((s) => (
                <li key={s.id} className="lib-row">
                  <button type="button" className={`lib-item${ws.ref?.kind === 'remote' && ws.ref.id === s.id ? ' is-active' : ''}`} onClick={() => navigate(`/lab/${s.id}`)}>
                    <span className="lib-item__title">{s.name}</span>
                    <span className="lib-item__sub">
                      {s.vertexCount} intersections · {new Date(s.updatedAt).toLocaleDateString()}
                    </span>
                  </button>
                  <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Duplicate ${s.name}`} onClick={() => void duplicateRemote(s.id)}>
                    <Icon name="layers" size={14} />
                  </button>
                  <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label={`Delete ${s.name}`} onClick={() => void removeRemote(s.id, s.name)}>
                    <Icon name="delete" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="library__foot">
        <button type="button" className="btn btn--quiet btn--sm" onClick={() => setImportOpen(true)} data-testid="open-import">
          <Icon name="import" size={14} /> Import
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            ws.loadGraph({ format: 'sweep.graph', version: 1, name: 'Untitled network', vertices: [], edges: [], source: { kind: 'user' } }, { kind: 'blank', id: 'blank' }, 'Untitled network');
            ws.setTool('add');
          }}
          data-testid="new-blank"
        >
          <Icon name="add" size={14} /> Blank
        </button>
      </div>
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}
    </aside>
  );
}
