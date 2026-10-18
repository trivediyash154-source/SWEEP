import { useState } from 'react';
import { geojsonToGraph, parseGraphJson, validateGraph, type Graph, type ValidationReport } from '@sweep/engine';
import { Dialog } from '../components/Dialog';
import { useWorkspace } from '../state/workspace';
import { toast } from '../state/toasts';

const MAX_BYTES = 5 * 1024 * 1024;

interface Preview {
  graph: Graph;
  kind: 'sweep' | 'geojson';
  validation: ValidationReport;
  notes: string[];
}

/**
 * Import a SWEEP graph (.json) or a GeoJSON street network. Files are parsed
 * locally with JSON.parse only (never evaluated) and previewed before loading.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const loadGraph = useWorkspace((s) => s.loadGraph);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleFile = async (file: File): Promise<void> => {
    setError(null);
    setPreview(null);
    if (file.size > MAX_BYTES) {
      setError('This file is larger than 5 MB.');
      return;
    }
    setBusy(true);
    try {
      const text = await file.text();
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new Error('The file is not valid JSON.');
      }
      const obj = raw as { type?: string };
      if (obj && (obj.type === 'FeatureCollection' || obj.type === 'Feature')) {
        const report = geojsonToGraph(raw, file.name.replace(/\.(geo)?json$/i, ''));
        const notes = [
          `${report.lineCount} line(s) from ${report.featureCount} feature(s) → ${report.graph.vertices.length} intersections and ${report.graph.edges.length} street segments.`,
          ...report.warnings,
          ...(report.skippedFeatures.length ? [`${report.skippedFeatures.length} feature(s) skipped: ${report.skippedFeatures.slice(0, 3).map((s) => s.reason).join(' ')}`] : []),
        ];
        setPreview({ graph: report.graph, kind: 'geojson', validation: validateGraph(report.graph), notes });
      } else {
        const graph = parseGraphJson(text);
        if (!graph.name) graph.name = file.name.replace(/\.json$/i, '');
        setPreview({ graph, kind: 'sweep', validation: validateGraph(graph), notes: [] });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const errors = preview?.validation.issues.filter((i) => i.severity === 'error') ?? [];
  const structural = errors.some((i) => ['EMPTY_GRAPH', 'INVALID_ID', 'DUPLICATE_VERTEX_ID', 'DUPLICATE_EDGE_ID', 'MISSING_ENDPOINT', 'INVALID_WEIGHT', 'INVALID_COORDINATE', 'INVALID_FIELD', 'LIMIT_EXCEEDED'].includes(i.code));

  return (
    <Dialog title="Import a street network" onClose={onClose}>
      <div className="form-stack">
        <p className="muted small">
          Accepts a SWEEP graph file (<span className="mono">.json</span>) or GeoJSON with LineString / MultiLineString streets in longitude–latitude. Intersections are detected where lines share a point; lengths are geodesic metres. Set a feature property <span className="mono">required: false</span> to mark a street optional.
        </p>
        <label className="dropzone">
          <input type="file" accept=".json,.geojson,application/json,application/geo+json" onChange={(e) => e.target.files?.[0] && void handleFile(e.target.files[0])} data-testid="import-file" />
          <span>{busy ? 'Reading…' : 'Choose a file or drop it here'}</span>
          <span className="faint small">Max 5 MB · parsed locally, never executed</span>
        </label>
        {error && (
          <p className="field__error" role="alert">
            {error}
          </p>
        )}
        {preview && (
          <div className="import-preview" data-testid="import-preview">
            <p>
              <strong>{preview.graph.name ?? 'Imported network'}</strong> · {preview.graph.vertices.length} intersections · {preview.graph.edges.length} streets
            </p>
            {preview.notes.map((n, i) => (
              <p key={i} className="faint small">
                {n}
              </p>
            ))}
            {errors.length > 0 && (
              <ul className="diag-list">
                {errors.slice(0, 5).map((i, idx) => (
                  <li key={idx} className="diag diag--error">
                    <span className="diag__badge">error</span>
                    <span>{i.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="dialog__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!preview || structural}
            onClick={() => {
              if (!preview) return;
              loadGraph(preview.graph, { kind: 'import', id: 'import' }, preview.graph.name ?? 'Imported network');
              toast.success('Network imported', errors.length ? 'Some issues need fixing before optimising — see Diagnostics.' : 'Ready to optimise.');
              onClose();
            }}
            data-testid="import-confirm"
          >
            Load into workspace
          </button>
        </div>
      </div>
    </Dialog>
  );
}
