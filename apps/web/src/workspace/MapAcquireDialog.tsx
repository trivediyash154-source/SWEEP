import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { bboxAreaKm2, bboxSizeMetres, DRIVABLE_ROAD_CLASSES, localProjection, MAX_BBOX_KM2, validateBbox, type BBox, type Graph, type Point } from '@sweep/engine';
import { Dialog } from '../components/Dialog';
import { acquireMap, bboxForPlace, fetchMapStatus, MAP_PRESETS, MapAcquireError, searchPlaces, type AcquireStage, type MapAcquisition, type MapAttempt, type MapStatus, type PlaceResult } from '../lib/maps';
import { formatDistance, formatNumber } from '../lib/format';
import '../styles/maps.css';

export interface MapAcquireDialogProps {
  open: boolean;
  onClose(): void;
  onLoad(graph: Graph): void;
}

interface ClassOption {
  value: string;
  label: string;
  links?: string[];
  extra?: boolean;
}

const CLASS_OPTIONS: ClassOption[] = [
  { value: 'primary', label: 'Primary', links: ['primary_link'] },
  { value: 'secondary', label: 'Secondary', links: ['secondary_link'] },
  { value: 'tertiary', label: 'Tertiary', links: ['tertiary_link'] },
  { value: 'unclassified', label: 'Unclassified' },
  { value: 'residential', label: 'Residential' },
  { value: 'living_street', label: 'Living street' },
  { value: 'service', label: 'Service' },
  { value: 'pedestrian', label: 'Pedestrian' },
  { value: 'trunk', label: 'Trunk road', links: ['trunk_link'], extra: true },
  { value: 'track', label: 'Track', extra: true },
  { value: 'footway', label: 'Footway', extra: true },
  { value: 'cycleway', label: 'Cycleway', extra: true },
  { value: 'path', label: 'Path', extra: true },
];
const DEFAULT_CLASSES = new Set(CLASS_OPTIONS.filter((o) => DRIVABLE_ROAD_CLASSES.includes(o.value)).map((o) => o.value));

type Side = 's' | 'w' | 'n' | 'e';
const SIDES: { key: Side; label: string; hint: string }[] = [
  { key: 'n', label: 'North', hint: 'latitude' },
  { key: 'w', label: 'West', hint: 'longitude' },
  { key: 'e', label: 'East', hint: 'longitude' },
  { key: 's', label: 'South', hint: 'latitude' },
];

type Phase = { kind: 'idle' } | { kind: 'running'; startedAt: number; stage: AcquireStage } | { kind: 'done'; result: MapAcquisition } | { kind: 'error'; error: MapAcquireError | Error };

const toFields = (b: BBox): Record<Side, string> => ({ s: String(b[0]), w: String(b[1]), n: String(b[2]), e: String(b[3]) });
const host = (url?: string): string => {
  try {
    return url ? new URL(url).host : '—';
  } catch {
    return url ?? '—';
  }
};

/**
 * Download a real street network from OpenStreetMap (via the SWEEP server's
 * Overpass client, or directly from the browser in static builds), preview
 * it, and hand it to the workspace. Data © OpenStreetMap contributors (ODbL).
 */
export function MapAcquireDialog(props: MapAcquireDialogProps) {
  if (!props.open) return null;
  return <MapAcquireDialogBody {...props} />;
}

function MapAcquireDialogBody({ onClose, onLoad }: MapAcquireDialogProps) {
  const ids = useId();
  const [fields, setFields] = useState<Record<Side, string>>(() => toFields(MAP_PRESETS[0]!.bbox));
  const [classes, setClasses] = useState<Set<string>>(() => new Set(DEFAULT_CLASSES));
  const [keepAll, setKeepAll] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [elapsed, setElapsed] = useState(0);
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<PlaceResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [areaNote, setAreaNote] = useState<string | null>(null);
  const [status, setStatus] = useState<MapStatus | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    void fetchMapStatus(ctrl.signal).then((s) => !ctrl.signal.aborted && setStatus(s));
    return () => {
      ctrl.abort();
      abortRef.current?.abort();
    };
  }, []);

  const running = phase.kind === 'running';
  useEffect(() => {
    if (phase.kind !== 'running') return;
    const t = window.setInterval(() => setElapsed(Math.floor((performance.now() - phase.startedAt) / 1000)), 250);
    return () => window.clearInterval(t);
  }, [phase]);

  const bbox = useMemo<BBox | null>(() => {
    const nums = [fields.s, fields.w, fields.n, fields.e].map((v) => (v.trim() === '' ? Number.NaN : Number(v)));
    return nums.every(Number.isFinite) ? (nums as BBox) : null;
  }, [fields]);
  const problems = useMemo(() => (bbox ? validateBbox(bbox, MAX_BBOX_KM2) : ['Enter all four edges of the area as decimal degrees.']), [bbox]);
  const area = bbox ? bboxAreaKm2(bbox) : 0;
  const size = useMemo(() => (bbox && bbox[2] > bbox[0] && bbox[3] > bbox[1] ? bboxSizeMetres(bbox) : null), [bbox]);
  const roadClasses = useMemo(() => CLASS_OPTIONS.filter((o) => classes.has(o.value)).flatMap((o) => [o.value, ...(o.links ?? [])]), [classes]);
  const disabledByServer = status !== null && !status.enabled;
  const canAcquire = !running && problems.length === 0 && roadClasses.length > 0 && !disabledByServer;

  const setBbox = (b: BBox, note: string | null = null): void => {
    setFields(toFields(b));
    setAreaNote(note);
    if (phase.kind !== 'running') setPhase({ kind: 'idle' });
  };

  const onSearch = async (ev: FormEvent): Promise<void> => {
    ev.preventDefault();
    setSearchError(null);
    setPlaces(null);
    setSearching(true);
    try {
      setPlaces(await searchPlaces(query));
    } catch (err) {
      setSearchError((err as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const acquire = async (): Promise<void> => {
    if (!bbox || !canAcquire) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setElapsed(0);
    setPhase({ kind: 'running', startedAt: performance.now(), stage: 'contacting' });
    try {
      const result = await acquireMap(
        { bbox, roadClasses, keepAllComponents: keepAll },
        { signal: ctrl.signal, onStage: (stage) => !ctrl.signal.aborted && setPhase((p) => (p.kind === 'running' ? { ...p, stage } : p)) },
      );
      if (!ctrl.signal.aborted) setPhase({ kind: 'done', result });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setPhase({ kind: 'error', error: err as Error });
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  };

  const cancel = (): void => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase({ kind: 'idle' });
    setAreaNote('Download cancelled.');
  };

  const close = useCallback(() => {
    abortRef.current?.abort();
    onClose();
  }, [onClose]);

  const result = phase.kind === 'done' ? phase.result : null;
  const resultBbox = result?.graph.source?.bbox;
  const resultMatchesArea = !!(resultBbox && bbox && resultBbox.every((v, i) => v === bbox[i]));
  const problemsId = `${ids}-bbox-problems`;

  return (
    <Dialog title="Acquire streets from OpenStreetMap" onClose={close} wide describedBy={`${ids}-intro`}>
      <div className="map-dialog" data-testid="map-dialog">
        <p id={`${ids}-intro`} className="muted small">
          Downloads the public street network of a small area (at most {MAX_BBOX_KM2} km²) from OpenStreetMap through the Overpass API, then detects intersections, one-way streets and lengths in geodesic metres. Map data © OpenStreetMap contributors, ODbL 1.0.
        </p>
        {disabledByServer && (
          <p className="notice notice--warn" role="status">
            Live map acquisition is turned off on this server. Import a GeoJSON file or load the bundled Zurich Altstadt sample instead.
          </p>
        )}

        <div className="map-layout">
          <div className="map-controls">
            <form className="map-search" onSubmit={(e) => void onSearch(e)} role="search">
              <label className="field">
                <span className="field__label">Find a place</span>
                <span className="map-search__row">
                  <input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. Niederdorf, Zürich" maxLength={120} data-testid="map-search" aria-describedby={`${ids}-search-hint`} />
                  <button type="submit" className="btn btn--quiet" disabled={searching || query.trim().length < 2}>
                    {searching ? 'Searching…' : 'Search'}
                  </button>
                </span>
              </label>
              <span id={`${ids}-search-hint`} className="field__hint">
                Search by Nominatim · © OpenStreetMap contributors. Picking a result fills the area below.
              </span>
              {searchError && (
                <p className="field__error" role="alert">
                  {searchError}
                </p>
              )}
              {places && places.length === 0 && <p className="faint small">No places found.</p>}
              {places && places.length > 0 && (
                <ul className="map-places" aria-label="Search results">
                  {places.map((p, i) => (
                    <li key={`${p.lat},${p.lon},${i}`}>
                      <button
                        type="button"
                        className="map-place"
                        onClick={() => {
                          const { bbox: b, note } = bboxForPlace(p);
                          setBbox(b, note ?? `Area set from “${p.name.split(',')[0]}”.`);
                        }}
                      >
                        <span>{p.name}</span>
                        {p.type && <span className="faint mono small">{p.type}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </form>

            <div className="field">
              <span className="field__label" id={`${ids}-presets`}>
                Preset areas
              </span>
              <div className="map-presets" role="group" aria-labelledby={`${ids}-presets`}>
                {MAP_PRESETS.map((p) => (
                  <button key={p.id} type="button" className="btn btn--quiet btn--sm" onClick={() => setBbox(p.bbox, `Area set to ${p.label}.`)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <span className="field__hint">Presets are coordinates only; the streets are downloaded live.</span>
            </div>

            <fieldset className="map-fieldset">
              <legend className="field__label">Area (decimal degrees, WGS84)</legend>
              <div className="map-bbox">
                {SIDES.map((side) => (
                  <label key={side.key} className={`field map-bbox__${side.key}`}>
                    <span className="field__label">
                      {side.label} <span className="faint">({side.hint})</span>
                    </span>
                    <input
                      className="input input--mono"
                      type="number"
                      inputMode="decimal"
                      step="0.0001"
                      min={side.hint === 'latitude' ? -90 : -180}
                      max={side.hint === 'latitude' ? 90 : 180}
                      value={fields[side.key]}
                      onChange={(e) => {
                        const v = e.target.value;
                        setFields((f) => ({ ...f, [side.key]: v }));
                        setAreaNote(null);
                      }}
                      aria-invalid={problems.length > 0}
                      aria-describedby={problemsId}
                      data-testid={`map-bbox-${side.key}`}
                    />
                  </label>
                ))}
              </div>
              <output className="map-area small" aria-live="polite">
                {size ? `${formatNumber(area, area < 0.1 ? 3 : 2)} km² · ${formatDistance(Math.round(size.width))} × ${formatDistance(Math.round(size.height))}` : '—'} · limit {MAX_BBOX_KM2} km²
              </output>
              <div id={problemsId}>
                {problems.map((p) => (
                  <p key={p} className="field__error">
                    {p}
                  </p>
                ))}
                {areaNote && problems.length === 0 && <p className="field__hint">{areaNote}</p>}
              </div>
            </fieldset>

            <fieldset className="map-fieldset">
              <legend className="field__label">Road classes (OpenStreetMap highway=*)</legend>
              <div className="map-classes">
                {CLASS_OPTIONS.map((o) => (
                  <label key={o.value} className={`map-check${o.extra ? ' map-check--extra' : ''}`}>
                    <input
                      type="checkbox"
                      checked={classes.has(o.value)}
                      onChange={(e) =>
                        setClasses((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(o.value);
                          else next.delete(o.value);
                          return next;
                        })
                      }
                    />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
              {roadClasses.length === 0 && <p className="field__error">Choose at least one road class.</p>}
              <span className="field__hint">Link roads (ramps) are included with their class. Footways, paths and tracks are off by default.</span>
              <label className="map-check">
                <input type="checkbox" checked={keepAll} onChange={(e) => setKeepAll(e.target.checked)} />
                <span>Keep disconnected pieces (default: only the largest connected network)</span>
              </label>
            </fieldset>
          </div>

          <div className="map-side">
            <BboxPreview bbox={problems.length === 0 ? bbox : null} graph={resultMatchesArea ? result!.graph : null} size={size} />
            <div className="map-actions">
              {running ? (
                <button type="button" className="btn btn--ghost" onClick={cancel}>
                  Cancel download
                </button>
              ) : null}
              <button type="button" className="btn btn--primary" onClick={() => void acquire()} disabled={!canAcquire} aria-describedby={problems.length ? problemsId : undefined} data-testid="map-acquire">
                {running ? 'Acquiring…' : result ? 'Acquire again' : 'Acquire roads'}
              </button>
            </div>
            <div className="map-progress" role="status" aria-live="polite">
              {running && (
                <>
                  <span className="spinner" aria-hidden="true" />
                  <span>
                    {phase.stage === 'converting' ? 'Converting streets into a network…' : 'Contacting OpenStreetMap providers…'} <span className="mono">{elapsed} s</span>
                  </span>
                  {elapsed >= 10 && <span className="faint small block">Public providers can be busy; SWEEP tries several in turn (up to about two minutes).</span>}
                </>
              )}
            </div>
          </div>
        </div>

        {phase.kind === 'error' && <AcquireErrorCard error={phase.error} />}
        {result && <ResultCard result={result} onLoad={() => onLoad(result.graph)} />}

        <p className="map-attribution faint small">
          Map data ©{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
            OpenStreetMap contributors
          </a>{' '}
          (ODbL).{status ? ` Providers: ${status.endpoints.map(host).join(', ')}.` : ''}
        </p>
      </div>
    </Dialog>
  );
}

function AttemptsTable({ attempts, caption }: { attempts: MapAttempt[]; caption: string }) {
  return (
    <div className="map-attempts">
      <table className="table">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">Outcome</th>
            <th scope="col" className="num">
              Time
            </th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((a, i) => (
            <tr key={`${a.endpoint}-${i}`}>
              <td className="mono small">{a.host}</td>
              <td className="small">
                {a.ok ? (
                  <span className="chip chip--ok">OK{a.status ? ` · HTTP ${a.status}` : ''}</span>
                ) : (
                  <>
                    <span className={`chip ${a.skipped ? '' : 'chip--danger'}`}>
                      {a.skipped ? 'skipped' : a.errorClass ?? 'failed'}
                      {a.status ? ` · HTTP ${a.status}` : ''}
                    </span>{' '}
                    <span className="faint">{a.error}</span>
                  </>
                )}
              </td>
              <td className="num mono small">{a.skipped ? '—' : `${(a.ms / 1000).toFixed(1)} s`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AcquireErrorCard({ error }: { error: Error }) {
  const attempts = error instanceof MapAcquireError ? error.attempts : [];
  return (
    <div className="map-card map-card--error" role="alert" data-testid="map-error">
      <p>
        <strong>Could not acquire streets.</strong> {error.message}
      </p>
      {attempts.length > 0 && <AttemptsTable attempts={attempts} caption="Providers tried and their outcome" />}
    </div>
  );
}

function ResultCard({ result, onLoad }: { result: MapAcquisition; onLoad: () => void }) {
  const src = result.graph.source;
  const st = result.report.stats;
  const retrieved = src?.retrievedAt ? new Date(src.retrievedAt) : null;
  return (
    <section className="map-card" data-testid="map-result" aria-label="Acquired street network">
      <div className="map-card__head">
        <strong>{result.graph.name}</strong>
        <span className={`chip ${result.cached ? 'chip--accent' : 'chip--ok'}`}>{result.cached ? 'from cache' : 'freshly downloaded'}</span>
      </div>
      <dl className="map-stats">
        <div>
          <dt>Intersections</dt>
          <dd>{formatNumber(st.vertices)}</dd>
        </div>
        <div>
          <dt>Street segments</dt>
          <dd>{formatNumber(st.edges)}</dd>
        </div>
        <div>
          <dt>One-way segments</dt>
          <dd>{formatNumber(st.onewayEdges)}</dd>
        </div>
        <div>
          <dt>Total length</dt>
          <dd>{formatNumber(st.totalLength / 1000, 2)} km</dd>
        </div>
      </dl>
      <dl className="map-provenance">
        <dt>Provider</dt>
        <dd>{src?.provider ?? '—'}</dd>
        <dt>Endpoint</dt>
        <dd className="mono small">{host(src?.endpoint)}</dd>
        <dt>Retrieved</dt>
        <dd>
          {retrieved ? (
            <time dateTime={src!.retrievedAt}>
              {retrieved.toLocaleString()} <span className="faint mono small">({src!.retrievedAt})</span>
            </time>
          ) : (
            '—'
          )}
          {result.cached ? <span className="faint small"> · served from the cache</span> : null}
        </dd>
        <dt>Area</dt>
        <dd className="mono small">{src?.bbox ? `S ${src.bbox[0]} · W ${src.bbox[1]} · N ${src.bbox[2]} · E ${src.bbox[3]}` : '—'}</dd>
        <dt>Licence</dt>
        <dd>
          {src?.attribution ?? '© OpenStreetMap contributors'} ({src?.license ?? 'ODbL 1.0'})
        </dd>
      </dl>
      {result.report.notes.length > 0 && (
        <ul className="map-notes small">
          {result.report.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {result.attempts.length > 1 && (
        <details className="map-details">
          <summary className="small">Providers tried ({result.attempts.length})</summary>
          <AttemptsTable attempts={result.attempts} caption="Providers tried and their outcome" />
        </details>
      )}
      <p className="faint small">© OpenStreetMap contributors (ODbL) — this attribution stays with the network in exports.</p>
      <div className="dialog__actions">
        <button type="button" className="btn btn--primary" onClick={onLoad} data-testid="map-load">
          Load into workspace
        </button>
      </div>
    </section>
  );
}

const PREVIEW_W = 360;
const PREVIEW_H = 240;
const MAX_PREVIEW_EDGES = 5000;

/** Schematic preview: the requested box in true proportions, with the acquired streets once available. No map tiles. */
function BboxPreview({ bbox, graph, size }: { bbox: BBox | null; graph: Graph | null; size: { width: number; height: number } | null }) {
  const drawing = useMemo(() => {
    if (!bbox || !size) return null;
    const lat0 = (bbox[0] + bbox[2]) / 2;
    const lon0 = (bbox[1] + bbox[3]) / 2;
    const project = localProjection(lon0, lat0);
    const [x0, y0] = project([bbox[1], bbox[2]]); // north-west corner
    const [x1, y1] = project([bbox[3], bbox[0]]); // south-east corner
    const pad = 0.12;
    const fw = (x1 - x0) * (1 + 2 * pad);
    const fh = (y1 - y0) * (1 + 2 * pad);
    const scale = Math.min(PREVIEW_W / fw, PREVIEW_H / fh);
    const ox = PREVIEW_W / 2;
    const oy = PREVIEW_H / 2;
    const toSvg = (p: Point): string => `${(ox + p[0] * scale).toFixed(1)},${(oy + p[1] * scale).toFixed(1)}`;
    const rect = { x: ox + x0 * scale, y: oy + y0 * scale, w: (x1 - x0) * scale, h: (y1 - y0) * scale };
    let streets: { d: string; oneway: boolean }[] = [];
    if (graph) {
      const anchor = graph.vertices.find((v) => v.geo);
      if (anchor?.geo) {
        // The graph's planar frame differs from this one only by a translation (both are local equirectangular projections).
        const a = project(anchor.geo);
        const dx = a[0] - anchor.x;
        const dy = a[1] - anchor.y;
        const pos = new Map(graph.vertices.map((v) => [v.id, [v.x + dx, v.y + dy] as Point]));
        streets = graph.edges.slice(0, MAX_PREVIEW_EDGES).flatMap((e) => {
          const u = pos.get(e.u);
          const v = pos.get(e.v);
          if (!u || !v) return [];
          const pts: Point[] = [u, ...(e.shape ?? []).map((s) => [s[0] + dx, s[1] + dy] as Point), v];
          return [{ d: pts.map(toSvg).join(' '), oneway: e.oneway === true }];
        });
      }
    }
    return { rect, streets };
  }, [bbox, graph, size]);

  const label = drawing && size ? `Schematic preview of the selected area, ${Math.round(size.width)} by ${Math.round(size.height)} metres${graph ? `, showing ${graph.edges.length} acquired street segments` : ''}.` : 'No valid area selected.';
  return (
    <figure className="map-preview">
      <svg viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`} role="img" aria-label={label}>
        <defs>
          <pattern id="map-preview-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" className="map-preview__grid" />
          </pattern>
        </defs>
        <rect width={PREVIEW_W} height={PREVIEW_H} fill="url(#map-preview-grid)" />
        {drawing ? (
          <>
            <rect x={drawing.rect.x} y={drawing.rect.y} width={drawing.rect.w} height={drawing.rect.h} className="map-preview__box" />
            {drawing.streets.map((s, i) => (
              <polyline key={i} points={s.d} className={s.oneway ? 'map-preview__street map-preview__street--oneway' : 'map-preview__street'} />
            ))}
            {drawing.streets.length === 0 && (
              <>
                <line x1={PREVIEW_W / 2 - 8} y1={PREVIEW_H / 2} x2={PREVIEW_W / 2 + 8} y2={PREVIEW_H / 2} className="map-preview__cross" />
                <line x1={PREVIEW_W / 2} y1={PREVIEW_H / 2 - 8} x2={PREVIEW_W / 2} y2={PREVIEW_H / 2 + 8} className="map-preview__cross" />
              </>
            )}
            <text x={PREVIEW_W / 2} y={Math.max(12, drawing.rect.y - 6)} className="map-preview__label" textAnchor="middle">
              {size ? formatDistance(Math.round(size.width)) : ''}
            </text>
            <text x={Math.min(PREVIEW_W - 4, drawing.rect.x + drawing.rect.w + 6)} y={PREVIEW_H / 2} className="map-preview__label" textAnchor="start" dominantBaseline="middle">
              {size ? formatDistance(Math.round(size.height)) : ''}
            </text>
            <text x={10} y={18} className="map-preview__label">
              N ↑
            </text>
          </>
        ) : (
          <text x={PREVIEW_W / 2} y={PREVIEW_H / 2} className="map-preview__label" textAnchor="middle">
            Enter a valid area
          </text>
        )}
      </svg>
      <figcaption className="faint small">
        Schematic only (no map tiles).{graph ? ' Accent lines are one-way streets; streets crossing the edge are kept whole.' : ''}
      </figcaption>
    </figure>
  );
}
