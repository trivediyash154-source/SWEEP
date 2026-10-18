import { useState } from 'react';
import { Dialog } from '../components/Dialog';
import { useWorkspace } from '../state/workspace';

/** Keyboard-accessible tabular editor for every street (alternative to the canvas). */
export function StreetsDialog({ onClose }: { onClose: () => void }) {
  const graph = useWorkspace((s) => s.graph);
  const updateEdge = useWorkspace((s) => s.updateEdge);
  const select = useWorkspace((s) => s.select);
  const [filter, setFilter] = useState('');
  const rows = graph.edges.filter((e) => !filter || `${e.id} ${e.name ?? ''} ${e.u} ${e.v}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Dialog title="Streets" onClose={onClose} wide>
      <div className="form-stack">
        <input className="input" placeholder="Filter by id, name or intersection" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter streets" />
        <div className="table-scroll">
          <table className="table">
            <caption className="visually-hidden">All streets with editable length and service requirement</caption>
            <thead>
              <tr>
                <th scope="col">Street</th>
                <th scope="col">From — to</th>
                <th scope="col" className="num">
                  Length (m)
                </th>
                <th scope="col">Required</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 400).map((e) => (
                <tr key={e.id}>
                  <td>
                    <button type="button" className="link-btn" onClick={() => select({ type: 'edge', id: e.id })}>
                      {e.name ?? e.id}
                    </button>
                  </td>
                  <td className="mono small">
                    {e.u} — {e.v}
                  </td>
                  <td className="num">
                    <input
                      className="input input--mono input--compact"
                      defaultValue={e.weight}
                      aria-label={`Length of ${e.name ?? e.id}`}
                      inputMode="decimal"
                      onBlur={(ev) => {
                        const v = Number(ev.target.value);
                        if (Number.isFinite(v) && v >= 0 && v <= 1_000_000 && v !== e.weight) updateEdge(e.id, { weight: v });
                        else ev.target.value = String(e.weight);
                      }}
                    />
                  </td>
                  <td>
                    <input type="checkbox" checked={e.required} onChange={(ev) => updateEdge(e.id, { required: ev.target.checked })} aria-label={`${e.name ?? e.id} is required`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 400 && <p className="faint small">Showing the first 400 of {rows.length} streets. Use the filter to narrow down.</p>}
        </div>
      </div>
    </Dialog>
  );
}
