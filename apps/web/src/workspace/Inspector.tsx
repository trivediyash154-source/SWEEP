import { useMemo, useState } from 'react';
import type { Issue } from '@sweep/engine';
import { useWorkspace } from '../state/workspace';
import { formatDistance, formatNumber } from '../lib/format';
import { Icon } from '../components/Icon';
import { StreetsDialog } from './StreetsDialog';

function NumberField({ label, value, onCommit, testId }: { label: string; value: number; onCommit: (v: number) => void; testId?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const parsed = Number(shown);
  const invalid = draft !== null && (shown.trim() === '' || !Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000);
  const commit = (): void => {
    if (draft === null) return;
    if (!invalid) onCommit(Math.round(parsed * 1000) / 1000);
    setDraft(null);
  };
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
        className="input input--mono"
        inputMode="decimal"
        value={shown}
        aria-invalid={invalid}
        data-testid={testId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(null);
        }}
      />
      {invalid ? <span className="field__error">Enter a length between 0 and 1,000,000.</span> : null}
    </label>
  );
}

function TextField({ label, value, placeholder, onCommit }: { label: string; value: string; placeholder?: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      <input
        className="input"
        value={draft ?? value}
        placeholder={placeholder}
        maxLength={120}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) onCommit(draft.trim());
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

const SEVERITY_ORDER: Record<Issue['severity'], number> = { error: 0, warning: 1, info: 2 };

export function Inspector() {
  const ws = useWorkspace();
  const { graph, selection, validation, result, stale } = ws;
  const [streetsOpen, setStreetsOpen] = useState(false);

  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of graph.edges) {
      if (!e.required) continue;
      d.set(e.u, (d.get(e.u) ?? 0) + 1);
      d.set(e.v, (d.get(e.v) ?? 0) + 1);
    }
    return d;
  }, [graph]);
  const oddCount = [...degree.values()].filter((d) => d % 2 === 1).length;

  const v = selection?.type === 'vertex' ? graph.vertices.find((x) => x.id === selection.id) : undefined;
  const e = selection?.type === 'edge' ? graph.edges.find((x) => x.id === selection.id) : undefined;
  const issues = [...validation.issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const traversals = result && !stale && e ? result.route.traversalCounts[e.id] ?? 0 : null;

  return (
    <div className="inspector" data-testid="inspector">
      <section className="panel-section" aria-labelledby="sel-h">
        <h2 id="sel-h" className="panel-title">
          {v ? 'Intersection' : e ? 'Street' : 'Selection'}
        </h2>
        {!v && !e && <p className="muted small">Select an intersection or street on the canvas to edit it. Tools: <span className="kbd">V</span> select, <span className="kbd">A</span> add, <span className="kbd">C</span> connect, <span className="kbd">R</span> required, <span className="kbd">X</span> delete, <span className="kbd">S</span> start.</p>}
        {v && (
          <div className="form-stack" key={v.id}>
            <div className="kv">
              <span>Id</span>
              <span className="mono">{v.id}</span>
              <span>Required degree</span>
              <span className="mono">
                {degree.get(v.id) ?? 0}
                {(degree.get(v.id) ?? 0) % 2 === 1 ? <span className="chip chip--odd">odd</span> : null}
              </span>
              <span>Position</span>
              <span className="mono">
                {formatNumber(v.x)}, {formatNumber(v.y)}
              </span>
            </div>
            <TextField label="Label" value={v.label ?? ''} placeholder="e.g. Market Square" onCommit={(label) => ws.updateVertex(v.id, { label })} />
            <div className="btn-row">
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => ws.setDepot(v.id)} disabled={graph.depotId === v.id}>
                <Icon name="depot" size={14} /> {graph.depotId === v.id ? 'Route start' : 'Set as start'}
              </button>
              <button type="button" className="btn btn--danger btn--sm" onClick={() => ws.removeVertex(v.id)}>
                <Icon name="delete" size={14} /> Delete
              </button>
            </div>
          </div>
        )}
        {e && (
          <div className="form-stack" key={e.id}>
            <div className="kv">
              <span>Id</span>
              <span className="mono">{e.id}</span>
              <span>Joins</span>
              <span className="mono">
                {e.u} — {e.v}
              </span>
              {traversals !== null && (
                <>
                  <span>Traversed</span>
                  <span className="mono">{traversals}×</span>
                </>
              )}
            </div>
            <TextField label="Street name" value={e.name ?? ''} placeholder="Unnamed street" onCommit={(name) => ws.updateEdge(e.id, { name })} />
            <NumberField label="Length (m)" value={e.weight} onCommit={(weight) => ws.updateEdge(e.id, { weight })} testId="edge-weight" />
            <label className="switch">
              <input type="checkbox" checked={e.required} onChange={(ev) => ws.updateEdge(e.id, { required: ev.target.checked })} data-testid="edge-required" />
              <span className="switch__track" aria-hidden="true" />
              Required service street
            </label>
            <div className="btn-row">
              <button type="button" className="btn btn--danger btn--sm" onClick={() => ws.removeEdge(e.id)}>
                <Icon name="delete" size={14} /> Delete street
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel-section" aria-labelledby="net-h">
        <div className="panel-title-row">
          <h2 id="net-h" className="panel-title">
            Network
          </h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setStreetsOpen(true)}>
            <Icon name="table" size={14} /> Streets table
          </button>
        </div>
        <dl className="stat-grid">
          <div>
            <dt>Intersections</dt>
            <dd className="num">{formatNumber(graph.vertices.length)}</dd>
          </div>
          <div>
            <dt>Streets</dt>
            <dd className="num">{formatNumber(graph.edges.length)}</dd>
          </div>
          <div>
            <dt>Required</dt>
            <dd className="num">{formatNumber(validation.stats.requiredEdgeCount)}</dd>
          </div>
          <div>
            <dt>Odd intersections</dt>
            <dd className="num" style={{ color: 'var(--odd)' }}>
              {formatNumber(oddCount)}
            </dd>
          </div>
          <div className="span-2">
            <dt>Required length</dt>
            <dd className="num">{formatDistance(validation.stats.requiredWeight)}</dd>
          </div>
        </dl>
        <div className="btn-row">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => ws.setAllRequired(true)}>
            Mark all required
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => ws.setAllRequired(false)}>
            Mark all optional
          </button>
        </div>
      </section>

      <section className="panel-section" aria-labelledby="diag-h" aria-live="polite">
        <h2 id="diag-h" className="panel-title">
          Diagnostics
        </h2>
        {issues.length === 0 ? (
          <p className="diag diag--ok">
            <Icon name="check" size={14} /> Ready to optimise.
          </p>
        ) : (
          <ul className="diag-list">
            {issues.map((i, idx) => (
              <li
                key={`${i.code}-${idx}`}
                className={`diag diag--${i.severity}`}
                onMouseEnter={() => ws.setHighlight(i.vertexIds ?? [])}
                onMouseLeave={() => ws.setHighlight([])}
              >
                <span className="diag__badge">{i.severity}</span>
                <span>{i.message}</span>
                {i.code === 'REQUIRED_DISCONNECTED' && validation.connectorSuggestion && validation.connectorSuggestion.edgeIds.length > 0 && (
                  <div className="diag__action">
                    <button type="button" className="btn btn--quiet btn--sm" onClick={() => ws.applyConnectorSuggestion()} data-testid="apply-connectors">
                      Mark {validation.connectorSuggestion.edgeIds.length} connecting street{validation.connectorSuggestion.edgeIds.length === 1 ? '' : 's'} as required (+{formatDistance(validation.connectorSuggestion.weight)})
                    </button>
                    <p className="faint small">{validation.connectorSuggestion.note}</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {streetsOpen && <StreetsDialog onClose={() => setStreetsOpen(false)} />}
    </div>
  );
}
