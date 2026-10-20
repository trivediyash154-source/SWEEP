import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type Map as MLMap, type MapMouseEvent } from 'maplibre-gl';
import { DRIVABLE_ROAD_CLASSES, MAX_BBOX_KM2, type CityModel, type Graph } from '@sweep/engine';
import { SiteNav } from '../components/SiteNav';
import { MapCanvas, setGeoJson, EMPTY_FC } from '../map/MapCanvas';
import { PlaceSearch } from '../map/PlaceSearch';
import { acquireLargeArea, acquireMap, MapAcquireError, MAX_TILED_KM2, splitBBox } from '../lib/maps';
import { formatTravelDistance, formatTravelTime, type LngLat } from '../lib/directions';
import { downloadText, safeFileName } from '../lib/storage';
import { DEFAULT_SWEEP_SETTINGS, edgeGeometries, planToCsv, planToGpx, positionAt, ringAreaKm2, ringSelfIntersects, zoneBBox, zoneGraph, zoneRing, type LngLatPair, type SweepPlan, type SweepSettings, type Zone } from './plan';
import { planInWorker } from './sweepClient';
import { bundledCoverage, bundledStreetGraph, coversBox, type BundledCoverage } from './bundled';
import { DEFAULT_CITY, fetchCity } from '../city/data';
import '../styles/atlas.css';

const PUNE: [number, number] = [73.8682, 18.4636];
const VEHICLE_COLORS = ['#3d8bfd', '#e5484d', '#2fbf71', '#f0a020', '#a35cff', '#00a3a3', '#d6409f', '#8a6d3b'];
/** The download box is the zone's box plus this margin, so streets just outside can be used to travel. */
const MARGIN_M = 150;
const ROAD_SETS: { id: string; label: string; classes: readonly string[] }[] = [
  { id: 'all', label: 'All streets (incl. trunk roads)', classes: [...DRIVABLE_ROAD_CLASSES, 'trunk', 'trunk_link'] },
  { id: 'city', label: 'City streets (no trunk roads)', classes: DRIVABLE_ROAD_CLASSES },
  { id: 'local', label: 'Local streets only', classes: ['residential', 'living_street', 'unclassified', 'service', 'pedestrian'] },
];

type Tool = 'none' | 'rect' | 'polygon' | 'depot';

/** A square zone of `sideKm` around a point (south, west, north, east). */
function squareZone(lat: number, lng: number, sideKm: number): Zone {
  const dLat = (sideKm * 500) / 111_195;
  const dLng = (sideKm * 500) / (111_195 * Math.cos((lat * Math.PI) / 180));
  const r = (x: number): number => Math.round(x * 1e6) / 1e6;
  return { kind: 'rect', bbox: [r(lat - dLat), r(lng - dLng), r(lat + dLat), r(lng + dLng)] };
}
/** Real places in Pune to try in one click. Zones inside the bundled extract plan at once; the others download their streets live. */
const EXAMPLES: { id: string; label: string; lat: number; lng: number; sideKm: number }[] = [
  { id: 'vit', label: 'Around VIT Bibwewadi · 1 km²', lat: 18.4636, lng: 73.8682, sideKm: 1 },
  { id: 'bibwewadi', label: 'Bibwewadi & VIT · 4 km²', lat: 18.4605, lng: 73.868, sideKm: 2 },
  { id: 'kothrud', label: 'Kothrud · 4 km²', lat: 18.5074, lng: 73.8077, sideKm: 2 },
  { id: 'peths', label: 'Old city (Peths) · 9 km²', lat: 18.5167, lng: 73.8563, sideKm: 3 },
  { id: 'centre', label: 'Pune centre · 20 km²', lat: 18.52, lng: 73.855, sideKm: 4.45 },
];
type Status = 'idle' | 'downloading' | 'planning' | 'done' | 'error';
/** Where the zone's streets come from: the bundled extract when it covers the zone ('auto'), or always a live download. */
type StreetSource = 'auto' | 'live';
interface Bundle {
  city: CityModel;
  cov: BundledCoverage;
}

function expandBBox([s, w, n, e]: [number, number, number, number], m: number): [number, number, number, number] {
  const dLat = m / 111_195;
  const dLng = m / (111_195 * Math.cos((((s + n) / 2) * Math.PI) / 180));
  return [s - dLat, w - dLng, n + dLat, e + dLng];
}
function bboxKm2([s, w, n, e]: [number, number, number, number]): number {
  return ringAreaKm2([
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ]);
}
function centroid(ring: LngLatPair[]): LngLatPair {
  const x = ring.reduce((a, p) => a + p[0], 0) / ring.length;
  const y = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  return [x, y];
}
const pct = (x: number | null) => (x === null ? '–' : `${(x * 100).toFixed(1)} %`);
/** Clock time for `s` seconds after a 06:00 shift start. */
function clockLabel(s: number): string {
  const total = Math.round(6 * 3600 + s);
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** The algorithm behind a plan. Whether the plan is proven optimal is shown separately, from the plan itself. */
const METHOD: Record<SweepPlan['method'], string> = {
  'exact-directed-min-cost-flow': 'min-cost flow, one-way streets obeyed',
  'exact-undirected-edmonds-johnson': 'Edmonds–Johnson matching, one-ways ignored',
  'heuristic-candidate-matching': 'candidate-matching heuristic, one-ways ignored',
};

export default function SweepPage() {
  const mapRef = useRef<MLMap | null>(null);
  const [tool, setTool] = useState<Tool>('none');
  const toolRef = useRef<Tool>('none');
  toolRef.current = tool;
  const [draft, setDraft] = useState<LngLatPair[]>([]);
  const draftRef = useRef<LngLatPair[]>([]);
  draftRef.current = draft;
  const [hover, setHover] = useState<LngLatPair | null>(null);
  const [zone, setZone] = useState<Zone | null>(null);
  const [zoneError, setZoneError] = useState<string | null>(null);
  const [depot, setDepot] = useState<LngLatPair | null>(null);
  const [settings, setSettings] = useState<SweepSettings>(DEFAULT_SWEEP_SETTINGS);
  const [roadSet, setRoadSet] = useState('all');
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<SweepPlan | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [streetSource, setStreetSource] = useState<StreetSource>('auto');
  const [usedBundle, setUsedBundle] = useState<boolean | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  // The bundled real Pune extract (already shipped with the site), loaded once in the background.
  const bundleRef = useRef<Promise<Bundle | null> | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const loadBundle = useCallback((): Promise<Bundle | null> => {
    bundleRef.current ??= fetchCity({ file: `cities/${DEFAULT_CITY}.json` })
      .then(({ city }) => {
        const b = { city, cov: bundledCoverage(city) };
        setBundle(b);
        return b;
      })
      .catch(() => null);
    return bundleRef.current;
  }, []);
  useEffect(() => {
    void loadBundle();
  }, [loadBundle]);
  const [planKey, setPlanKey] = useState<string | null>(null);
  const depotMarker = useRef<maplibregl.Marker | null>(null);
  // Shift playback: seconds since the shift start, and how fast the clock runs.
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(300);

  const zoneArea = zone ? ringAreaKm2(zoneRing(zone)) : 0;
  const downloadBox = zone ? expandBBox(zoneBBox(zone), MARGIN_M) : null;
  const downloadArea = downloadBox ? bboxKm2(downloadBox) : 0;
  const tiled = downloadArea > MAX_BBOX_KM2;
  const tooLarge = downloadArea > MAX_TILED_KM2;
  const tileCount = downloadBox && tiled ? splitBBox(downloadBox).length : 1;
  const [progress, setProgress] = useState<string | null>(null);
  const inputKey = JSON.stringify([zone, depot, settings, roadSet, streetSource]);
  const instant = (box: [number, number, number, number] | null): boolean => streetSource === 'auto' && !!bundle && !!box && coversBox(bundle.cov, box);
  const zoneInstant = instant(downloadBox);
  const stale = plan !== null && planKey !== inputKey;

  // Test and debugging hook (read-only state).
  useEffect(() => {
    (window as unknown as { __sweepPlanner?: unknown }).__sweepPlanner = { state: () => ({ zone, depot, plan, graph, settings, roadClasses: ROAD_SETS.find((r) => r.id === roadSet)!.classes, status, usedBundle }) };
  }, [zone, depot, plan, graph, settings, roadSet, status, usedBundle]);
  // Bring the result into view once a plan is ready.
  useEffect(() => {
    if (plan) resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [plan]);

  const finishZone = useCallback((z: Zone) => {
    const ring = zoneRing(z);
    if (z.kind === 'polygon' && ringSelfIntersects(ring)) {
      setZoneError('The outline crosses itself. Draw it again without crossing lines.');
      return;
    }
    const area = ringAreaKm2(ring);
    if (area < 0.002) {
      setZoneError('The zone is too small. Draw a larger area.');
      return;
    }
    setZoneError(null);
    setZone(z);
    setDraft([]);
    setTool('none');
  }, []);

  // ---- map layers -----------------------------------------------------------
  const zoneData = useMemo<GeoJSON.FeatureCollection>(() => {
    const features: GeoJSON.Feature[] = [];
    if (zone) features.push({ type: 'Feature', properties: { kind: 'zone' }, geometry: { type: 'Polygon', coordinates: [[...zoneRing(zone), zoneRing(zone)[0]!]] } });
    if (draft.length) {
      const pts = hover ? [...draft, hover] : draft;
      if (tool === 'rect' && pts.length === 2) {
        const [a, b] = pts as [LngLatPair, LngLatPair];
        const ring: LngLatPair[] = [a, [b[0], a[1]], b, [a[0], b[1]], a];
        features.push({ type: 'Feature', properties: { kind: 'draft' }, geometry: { type: 'Polygon', coordinates: [ring] } });
      } else if (pts.length >= 2) features.push({ type: 'Feature', properties: { kind: 'draft-line' }, geometry: { type: 'LineString', coordinates: pts } });
      for (const p of draft) features.push({ type: 'Feature', properties: { kind: 'vertex' }, geometry: { type: 'Point', coordinates: p } });
    }
    return { type: 'FeatureCollection', features };
  }, [zone, draft, hover, tool]);

  const streetData = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!graph || !zone) return EMPTY_FC;
    const geoms = edgeGeometries(graph);
    const zg = zoneGraph(graph, zone, geoms);
    return { type: 'FeatureCollection', features: zg.graph.edges.map((e) => ({ type: 'Feature', properties: { required: e.required ? 1 : 0 }, geometry: { type: 'LineString', coordinates: geoms.get(e.id)! } })) };
  }, [graph, zone]);

  const routeData = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!plan) return EMPTY_FC;
    return { type: 'FeatureCollection', features: plan.routes.map((r) => ({ type: 'Feature', properties: { color: VEHICLE_COLORS[(r.vehicle - 1) % VEHICLE_COLORS.length] }, geometry: { type: 'LineString', coordinates: r.coords } })) };
  }, [plan]);

  const vehicleState = useMemo(() => (plan ? plan.routes.map((r) => ({ r, ...positionAt(r, t, settings.serviceKmh, settings.transitKmh) })) : []), [plan, t, settings.serviceKmh, settings.transitKmh]);
  const vehicleData = useMemo<GeoJSON.FeatureCollection>(
    () => ({ type: 'FeatureCollection', features: vehicleState.map((v) => ({ type: 'Feature', properties: { color: VEHICLE_COLORS[(v.r.vehicle - 1) % VEHICLE_COLORS.length] }, geometry: { type: 'Point', coordinates: v.at } })) }),
    [vehicleState],
  );
  useEffect(() => {
    setT(0);
    setPlaying(false);
  }, [plan]);
  useEffect(() => {
    if (!playing || !plan) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((x) => {
        const next = Math.min(plan.totals.makespanSeconds, x + dt * speed);
        if (next >= plan.totals.makespanSeconds) setPlaying(false);
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, plan, speed]);

  const data = useRef({ zoneData, streetData, routeData, vehicleData });
  data.current = { zoneData, streetData, routeData, vehicleData };

  const addLayers = useCallback((map: MLMap) => {
    const d = data.current;
    if (!map.getSource('sweep-zone')) map.addSource('sweep-zone', { type: 'geojson', data: d.zoneData });
    if (!map.getSource('sweep-streets')) map.addSource('sweep-streets', { type: 'geojson', data: d.streetData });
    if (!map.getSource('sweep-routes')) map.addSource('sweep-routes', { type: 'geojson', data: d.routeData });
    if (!map.getSource('sweep-vehicles')) map.addSource('sweep-vehicles', { type: 'geojson', data: d.vehicleData });
    const add = (spec: Parameters<MLMap['addLayer']>[0]) => {
      if (!map.getLayer(spec.id)) map.addLayer(spec);
    };
    add({ id: 'zone-fill', type: 'fill', source: 'sweep-zone', filter: ['in', ['get', 'kind'], ['literal', ['zone', 'draft']]], paint: { 'fill-color': '#3d8bfd', 'fill-opacity': 0.08 } });
    add({ id: 'zone-line', type: 'line', source: 'sweep-zone', filter: ['in', ['get', 'kind'], ['literal', ['zone', 'draft', 'draft-line']]], paint: { 'line-color': '#3d8bfd', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
    add({ id: 'zone-vertex', type: 'circle', source: 'sweep-zone', filter: ['==', ['get', 'kind'], 'vertex'], paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-color': '#3d8bfd', 'circle-stroke-width': 2 } });
    add({ id: 'streets-optional', type: 'line', source: 'sweep-streets', filter: ['==', ['get', 'required'], 0], paint: { 'line-color': '#8a8f99', 'line-width': 1.5, 'line-opacity': 0.6 } });
    add({ id: 'streets-required', type: 'line', source: 'sweep-streets', filter: ['==', ['get', 'required'], 1], paint: { 'line-color': '#f0a020', 'line-width': 3, 'line-opacity': 0.85 } });
    add({ id: 'routes', type: 'line', source: 'sweep-routes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.9 } });
    add({ id: 'vehicles', type: 'circle', source: 'sweep-vehicles', paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource('sweep-zone')) return;
    setGeoJson(map, 'sweep-zone', zoneData);
    setGeoJson(map, 'sweep-streets', streetData);
    setGeoJson(map, 'sweep-routes', routeData);
    setGeoJson(map, 'sweep-vehicles', vehicleData);
  }, [zoneData, streetData, routeData, vehicleData]);

  // Depot marker: the chosen point, or the depot the plan used.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const p = plan && !stale ? plan.depot : depot;
    if (!p) {
      depotMarker.current?.remove();
      depotMarker.current = null;
      return;
    }
    if (!depotMarker.current) {
      depotMarker.current = new maplibregl.Marker({ color: '#1f2937' }).setLngLat(p).addTo(map);
      depotMarker.current.getElement().setAttribute('data-testid', 'sweep-depot-marker');
      depotMarker.current.getElement().setAttribute('aria-label', 'Depot');
    } else depotMarker.current.setLngLat(p);
  }, [depot, plan, stale]);

  const onMap = useCallback(
    (map: MLMap) => {
      mapRef.current = map;
      map.on('click', (e: MapMouseEvent) => {
        const p: LngLatPair = [e.lngLat.lng, e.lngLat.lat];
        const t = toolRef.current;
        if (t === 'depot') {
          setDepot(p);
          setTool('none');
        } else if (t === 'rect') {
          const d = draftRef.current;
          if (d.length === 0) setDraft([p]);
          else {
            const [a] = d as [LngLatPair];
            finishZone({ kind: 'rect', bbox: [Math.min(a[1], p[1]), Math.min(a[0], p[0]), Math.max(a[1], p[1]), Math.max(a[0], p[0])] });
          }
        } else if (t === 'polygon') {
          const d = draftRef.current;
          // Clicking the first point again closes the outline.
          if (d.length >= 3) {
            const first = map.project(d[0]!);
            if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < 10) {
              finishZone({ kind: 'polygon', ring: d });
              return;
            }
          }
          setDraft([...d, p]);
        }
      });
      map.on('mousemove', (e: MapMouseEvent) => {
        if (toolRef.current === 'rect' || toolRef.current === 'polygon') setHover([e.lngLat.lng, e.lngLat.lat]);
      });
    },
    [finishZone],
  );

  // Drawing mode: crosshair cursor, no double-click zoom; Enter closes an outline, Escape cancels.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const drawing = tool !== 'none';
    map.getCanvas().style.cursor = drawing ? 'crosshair' : '';
    if (drawing) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
    if (!drawing) setHover(null);
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) return;
      if (e.key === 'Escape') {
        setTool('none');
        setDraft([]);
      } else if (e.key === 'Enter' && tool === 'polygon' && draftRef.current.length >= 3) finishZone({ kind: 'polygon', ring: draftRef.current });
      else if (e.key === 'Backspace' && tool === 'polygon') setDraft((d) => d.slice(0, -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, finishZone]);

  const useView = () => {
    const map = mapRef.current;
    if (!map) return;
    const b = map.getBounds();
    finishZone({ kind: 'rect', bbox: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()] });
  };

  /** Get the zone's streets (bundled extract or live download) and plan. `z` lets an example plan before its state lands. */
  const run = async (z: Zone | null = zone) => {
    if (!z) return;
    const box = expandBBox(zoneBBox(z), MARGIN_M);
    const area = bboxKm2(box);
    if (area > MAX_TILED_KM2) return;
    setError(null);
    setPlan(null);
    const key = JSON.stringify([z, depot, settings, roadSet, streetSource]);
    try {
      const classes = ROAD_SETS.find((r) => r.id === roadSet)!.classes;
      const b = streetSource === 'auto' ? await loadBundle() : null;
      let streets: Graph;
      if (b && coversBox(b.cov, box)) {
        setStatus('planning');
        streets = bundledStreetGraph(b.city, classes);
        setUsedBundle(true);
        setSource(`the bundled OpenStreetMap extract of ${b.city.name} (shipped with the site, no download), ${streets.edges.length.toLocaleString('en')} street segments`);
      } else {
        setStatus('downloading');
        const req = { bbox: box.map((x) => Math.round(x * 1e6) / 1e6) as [number, number, number, number], roadClasses: [...classes], name: 'Sweep planner zone' };
        const acq = area > MAX_BBOX_KM2 ? await acquireLargeArea(req, { onProgress: (done, total) => setProgress(`Downloading streets: ${done} of ${total} tiles`) }) : await acquireMap(req);
        setProgress(null);
        streets = acq.graph;
        setUsedBundle(false);
        setSource(`${acq.graph.source?.provider ?? 'OpenStreetMap via Overpass API'}${acq.cached ? ' (cached)' : ''}, ${acq.report.stats.ways} ways, ${(acq.report.stats.totalLength / 1000).toFixed(1)} km`);
        setStatus('planning');
      }
      setGraph(streets);
      const res = await planInWorker(streets, z, depot ?? centroid(zoneRing(z)), settings);
      if (!res.ok) {
        setStatus('error');
        setError(res.message);
        return;
      }
      setPlan(res);
      setPlanKey(key);
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setProgress(null);
      setError(err instanceof MapAcquireError ? err.message : `Planning failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const tryExample = (x: (typeof EXAMPLES)[number]) => {
    const z = squareZone(x.lat, x.lng, x.sideKm);
    finishZone(z);
    if (z.kind === 'rect') mapRef.current?.fitBounds([[z.bbox[1], z.bbox[0]], [z.bbox[3], z.bbox[2]]], { padding: 40, duration: 600 });
    void run(z);
  };

  const near = useCallback((): LngLat | null => {
    const c = mapRef.current?.getCenter();
    return c ? { lng: c.lng, lat: c.lat } : null;
  }, []);

  const hint =
    tool === 'rect'
      ? draft.length === 0
        ? 'Click one corner of the zone'
        : 'Click the opposite corner'
      : tool === 'polygon'
        ? draft.length < 3
          ? 'Click to add points around the streets to sweep'
          : 'Keep clicking, or click the first point (or press Enter) to close the outline'
        : tool === 'depot'
          ? 'Click where the vehicles start and end (the depot)'
          : !zone
            ? 'Find the area, then draw the zone to sweep'
            : null;

  return (
    <div className="atlas">
      <SiteNav />
      <div className="atlas__body">
        <aside className="atlas__panel" aria-label="Street sweeping planner">
          <h1>Street sweeping planner</h1>
          <p className="atlas__lede">
            Pick an area of a city. SWEEP works out the shortest route a street-sweeping vehicle (or a fleet) must drive to sweep <strong>every street in it</strong>, obeying one-way streets, and proves how close that route is to the best possible. The routes are drawn on the map, and you can play the shift.
          </p>
          <button type="button" className="btn btn--primary btn--block" onClick={() => tryExample(EXAMPLES[0]!)} disabled={status === 'downloading' || status === 'planning'} data-testid="sweep-try">
            Try it now: sweep the streets around VIT
          </button>

          <div className="atlas__section">
            <h2>1 · Find the area</h2>
            <PlaceSearch label="Place" placeholder="Search a place, e.g. Kothrud, Pune" value="" near={near} onPick={(p) => mapRef.current?.flyTo({ center: [p.lng, p.lat], zoom: 16 })} testId="sweep-search" />
          </div>

          <div className="atlas__section">
            <h2>2 · Draw the zone</h2>
            <div className="atlas__row">
              <button type="button" className="btn btn--ghost btn--sm" aria-pressed={tool === 'rect'} onClick={() => { setDraft([]); setTool(tool === 'rect' ? 'none' : 'rect'); }} data-testid="sweep-draw-rect">
                ▭ Rectangle
              </button>
              <button type="button" className="btn btn--ghost btn--sm" aria-pressed={tool === 'polygon'} onClick={() => { setDraft([]); setTool(tool === 'polygon' ? 'none' : 'polygon'); }} data-testid="sweep-draw-polygon">
                ⬠ Outline
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={useView} data-testid="sweep-use-view">
                ⛶ Use this view
              </button>
            </div>
            <div className="atlas__row" data-testid="sweep-examples">
              <span className="atlas__note">Or plan a real area in one click:</span>
              {EXAMPLES.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  className="btn btn--ghost btn--sm"
                  data-testid={`sweep-example-${x.id}`}
                  onClick={() => tryExample(x)}
                  disabled={status === 'downloading' || status === 'planning'}
                >
                  {x.label}
                  {instant(expandBBox(zoneBBox(squareZone(x.lat, x.lng, x.sideKm)), MARGIN_M)) ? ' · instant' : ''}
                </button>
              ))}
            </div>
            {tool === 'polygon' && draft.length >= 3 && (
              <div className="atlas__row">
                <button type="button" className="btn btn--primary btn--sm" onClick={() => finishZone({ kind: 'polygon', ring: draft })} data-testid="sweep-finish">
                  Close outline
                </button>
                <button type="button" className="btn btn--quiet btn--sm" onClick={() => setDraft((d) => d.slice(0, -1))}>
                  Undo point
                </button>
              </div>
            )}
            {zoneError && <p className="atlas__error" role="alert">{zoneError}</p>}
            <p className="atlas__note" data-testid="sweep-zone">
              {zone
                ? zoneInstant
                  ? `${zone.kind === 'rect' ? 'Rectangle' : `${zoneRing(zone).length}-point outline`}, ${zoneArea.toFixed(2)} km². Its streets are in the bundled real Pune extract, so it plans at once with no download.`
                  : `${zone.kind === 'rect' ? 'Rectangle' : `${zoneRing(zone).length}-point outline`}, ${zoneArea.toFixed(2)} km². Download area with a ${MARGIN_M} m margin: ${downloadArea.toFixed(2)} km²${tiled ? `, fetched as ${tileCount} tiles of at most 3.5 km² each` : ''} (limit ${MAX_TILED_KM2} km²).`
                : 'No zone yet. Zoom to the streets, then draw a rectangle or an outline.'}
            </p>
            {tooLarge && <p className="atlas__error" role="alert" data-testid="sweep-too-large">This zone is too large to download live ({downloadArea.toFixed(1)} km² with the margin; the limit is {MAX_TILED_KM2} km², about 5 × 5 km, downloaded politely in tiles from the free OpenStreetMap servers). Draw a smaller zone or plan the area in parts.</p>}
            {tiled && !tooLarge && !zoneInstant && <p className="atlas__note" data-testid="sweep-tiled">A large zone: its streets are downloaded in {tileCount} tiles, one after another, which can take a minute. Planning several vehicles on very large zones may be refused by the fleet planner; one vehicle always works.</p>}
          </div>

          <div className="atlas__section">
            <h2>3 · Depot and fleet</h2>
            <div className="atlas__row">
              <button type="button" className="btn btn--ghost btn--sm" aria-pressed={tool === 'depot'} onClick={() => setTool(tool === 'depot' ? 'none' : 'depot')} data-testid="sweep-pick-depot">
                ⌂ {depot ? 'Move depot' : 'Place depot'}
              </button>
              <span className="atlas__note" data-testid="sweep-depot">{depot ? `Depot at ${depot[1].toFixed(5)}, ${depot[0].toFixed(5)}` : 'Default: the intersection nearest the zone centre'}</span>
            </div>
            <div className="segmented segmented--sm" role="group" aria-label="One-way streets">
              <button type="button" aria-pressed={settings.direction === 'directed'} onClick={() => setSettings({ ...settings, direction: 'directed' })} data-testid="sweep-dir-directed">
                Obey one-ways
              </button>
              <button type="button" aria-pressed={settings.direction === 'undirected'} onClick={() => setSettings({ ...settings, direction: 'undirected' })} data-testid="sweep-dir-undirected">
                Ignore one-ways (on foot)
              </button>
            </div>
            <div className="atlas__grid2">
              <label className="field">
                <span className="field__label">Vehicles</span>
                <input className="input" type="number" min={1} max={20} value={settings.vehicles} onChange={(e) => setSettings({ ...settings, vehicles: Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1))) })} data-testid="sweep-vehicles" />
              </label>
              <label className="field">
                <span className="field__label">Shift limit (hours)</span>
                <input className="input" type="number" min={0.5} max={24} step={0.5} placeholder="none" value={settings.shiftHours ?? ''} onChange={(e) => setSettings({ ...settings, shiftHours: e.target.value === '' ? null : Math.max(0.5, Number(e.target.value)) })} data-testid="sweep-shift" />
              </label>
              <label className="field">
                <span className="field__label">Sweeping speed (km/h)</span>
                <input className="input" type="number" min={1} max={60} value={settings.serviceKmh} onChange={(e) => setSettings({ ...settings, serviceKmh: Math.max(1, Number(e.target.value) || 8) })} />
              </label>
              <label className="field">
                <span className="field__label">Travel speed (km/h)</span>
                <input className="input" type="number" min={1} max={90} value={settings.transitKmh} onChange={(e) => setSettings({ ...settings, transitKmh: Math.max(1, Number(e.target.value) || 20) })} />
              </label>
            </div>
            <label className="field">
              <span className="field__label">Streets to sweep</span>
              <select className="input" value={roadSet} onChange={(e) => setRoadSet(e.target.value)} data-testid="sweep-roads">
                {ROAD_SETS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="segmented segmented--sm" role="group" aria-label="Street data">
              <button type="button" aria-pressed={streetSource === 'auto'} onClick={() => setStreetSource('auto')} data-testid="sweep-source-auto">
                Built-in Pune streets when they cover the zone
              </button>
              <button type="button" aria-pressed={streetSource === 'live'} onClick={() => setStreetSource('live')} data-testid="sweep-source-live">
                Always download live
              </button>
            </div>
            <label className="atlas__check">
              <input type="checkbox" checked={settings.turnAware} onChange={(e) => setSettings({ ...settings, turnAware: e.target.checked })} data-testid="sweep-turns" /> Order turns to avoid U-turns and right turns (same streets, same distance)
            </label>
          </div>

          <button type="button" className="btn btn--primary btn--block sweep-run" onClick={() => void run()} disabled={!zone || tooLarge || status === 'downloading' || status === 'planning'} data-testid="sweep-run">
            {status === 'downloading' ? (progress ?? 'Downloading streets…') : status === 'planning' ? 'Planning routes…' : plan && !stale ? 'Plan again' : 'Plan the sweeping routes'}
          </button>
          {stale && <p className="atlas__note" data-testid="sweep-stale">Inputs changed since this plan: plan again to update it.</p>}
          {error && <p className="atlas__error" role="alert" data-testid="sweep-error">{error}</p>}

          {plan && (
            <div className="atlas__section" data-testid="sweep-result" ref={resultRef}>
              <h2>Result</h2>
              <div>
                <span className={`badge ${plan.optimal && plan.routes.length === 1 ? 'badge--exact' : 'badge--heuristic'}`} data-testid="sweep-method">
                  {plan.routes.length > 1 || plan.fleetGuarantee
                    ? `Fleet plan (heuristic) on ${METHOD[plan.method]}`
                    : plan.optimal
                      ? `Proven optimal · ${METHOD[plan.method]}`
                      : `Not proven optimal: within ${pct(plan.lowerBound.gap)} of the proven bound · ${METHOD[plan.method]}`}
                </span>
              </div>
              <div>
                <div className="big-number" data-testid="sweep-total">{formatTravelDistance(plan.totals.distanceM)}</div>
                <div className="atlas__note">to sweep {plan.required.km.toFixed(2)} km of streets ({plan.required.segments} segments), {plan.routes.length > 1 ? `${plan.totals.vehiclesUsed} vehicles, finished in ${formatTravelTime(plan.totals.makespanSeconds)}` : `about ${formatTravelTime(plan.totals.makespanSeconds)}`}</div>
              </div>
              <dl className="facts">
                <dt>Sweeping</dt>
                <dd data-testid="sweep-service">
                  {formatTravelDistance(plan.totals.serviceM)}
                  {plan.direction === 'directed' ? ' (both sides of two-way streets, one pass along each one-way street)' : ' (each street once)'}
                </dd>
                <dt>Travel between</dt>
                <dd data-testid="sweep-deadhead">{formatTravelDistance(plan.totals.deadheadM)} (driving without sweeping)</dd>
                <dt>Best possible ≥</dt>
                <dd data-testid="sweep-bound">
                  {plan.fleetBounds ? formatTravelDistance(plan.fleetBounds.distanceM) : plan.lowerBound.distanceM !== null ? formatTravelDistance(plan.lowerBound.distanceM) : '–'} (proven lower bound)
                </dd>
                <dt>Gap</dt>
                <dd data-testid="sweep-gap">{plan.fleetBounds ? pct(plan.fleetBounds.distanceGap) : pct(plan.lowerBound.gap)} above the bound{plan.optimal && plan.routes.length === 1 ? ' (0 % means optimal)' : ''}</dd>
                {plan.fleetBounds && (
                  <>
                    <dt>Finish time</dt>
                    <dd data-testid="sweep-makespan">
                      {formatTravelTime(plan.totals.makespanSeconds)}; no plan with {settings.vehicles} vehicle{settings.vehicles === 1 ? '' : 's'} finishes before {formatTravelTime(plan.fleetBounds.makespanSeconds)}
                    </dd>
                  </>
                )}
                {plan.turns && (
                  <>
                    <dt>Turns</dt>
                    <dd data-testid="sweep-turns-result">
                      {plan.turns.after.uturn} U-turns, {plan.turns.after.right} right, {plan.turns.after.left} left; {formatTravelTime(plan.turns.after.seconds)} of turn penalties{plan.turns.ordered ? ` (was ${formatTravelTime(plan.turns.before.seconds)} before ordering)` : ''}
                    </dd>
                  </>
                )}
                {plan.direction === 'undirected' && plan.wrongWayTraversals > 0 && (
                  <>
                    <dt>Wrong way</dt>
                    <dd>{plan.wrongWayTraversals} one-way stretches driven against their direction (one-ways were ignored)</dd>
                  </>
                )}
                {plan.excludedSegments > 0 && (
                  <>
                    <dt>Left out</dt>
                    <dd>{plan.excludedSegments} one-way segments no closed legal route from the depot can sweep</dd>
                  </>
                )}
              </dl>
              {!plan.feasibility.ok && <p className="atlas__error">{plan.feasibility.issues.join(' ')}</p>}
              <div className="atlas__section" data-testid="sweep-timeline">
                <h2>Play the shift</h2>
                <div className="atlas__row">
                  <button type="button" className="btn btn--primary btn--sm" onClick={() => { if (t >= plan.totals.makespanSeconds) setT(0); setPlaying((p) => !p); }} data-testid="sweep-play">
                    {playing ? '❚❚ Pause' : '▶ Play'}
                  </button>
                  <label className="atlas__row atlas__note">
                    Speed
                    <select className="input" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
                      <option value={60}>60×</option>
                      <option value={300}>300×</option>
                      <option value={900}>900×</option>
                    </select>
                  </label>
                  <strong data-testid="sweep-clock">{clockLabel(t)}</strong>
                  <span className="atlas__note">ends {clockLabel(plan.totals.makespanSeconds)}</span>
                </div>
                <input type="range" min={0} max={Math.ceil(plan.totals.makespanSeconds)} step={1} value={Math.round(t)} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} aria-label="Time in the shift" data-testid="sweep-scrub" />
                <ul className="steps">
                  {vehicleState.map((v) => (
                    <li key={v.r.vehicle} className="atlas__row atlas__note" data-testid={`sweep-progress-${v.r.vehicle}`}>
                      <span className="swatch" style={{ background: VEHICLE_COLORS[(v.r.vehicle - 1) % VEHICLE_COLORS.length] }} />
                      Vehicle {v.r.vehicle}: {v.r.distanceM > 0 ? Math.round((100 * v.doneM) / v.r.distanceM) : 100} %{v.finished ? ', back at the depot' : ''}
                    </li>
                  ))}
                </ul>
                <p className="atlas__note">Shift starts 06:00; vehicles move at the sweeping speed on streets they sweep and the travel speed elsewhere, as planned. No traffic is modelled.</p>
              </div>
              {plan.routes.length > 1 && (
                <table className="vehicle-table" data-testid="sweep-vehicles-table">
                  <thead>
                    <tr>
                      <th>Vehicle</th>
                      <th>Distance</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.routes.map((r) => (
                      <tr key={r.vehicle}>
                        <td>
                          <span className="swatch" style={{ background: VEHICLE_COLORS[(r.vehicle - 1) % VEHICLE_COLORS.length] }} />
                          {r.vehicle}
                        </td>
                        <td>{formatTravelDistance(r.distanceM)}</td>
                        <td>
                          {formatTravelTime(r.seconds)}
                          {!r.feasibleShift ? ' (over the shift)' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="atlas__row">
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => downloadText(`${safeFileName('sweep-plan')}.gpx`, planToGpx(plan, 'SWEEP plan'), 'application/gpx+xml')} data-testid="sweep-gpx">
                  Download GPX
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => downloadText(`${safeFileName('sweep-plan')}.csv`, planToCsv(plan), 'text/csv')} data-testid="sweep-csv">
                  Download step list (CSV)
                </button>
              </div>
              <details className="atlas__note">
                <summary>What does this guarantee?</summary>
                <p>{plan.guarantee}</p>
                {plan.fleetGuarantee && <p>{plan.fleetGuarantee}</p>}
                <p>
                  Independent checks: {plan.checks.filter((c) => c.passed).length} of {plan.checks.length} passed{plan.checks.some((c) => !c.passed) ? ` (failed: ${plan.checks.filter((c) => !c.passed).map((c) => c.label).join('; ')})` : ''}. Planned in {(plan.timingsMs.total / 1000).toFixed(1)} s in this browser.
                </p>
              </details>
              {source && <p className="atlas__note">Streets: {source}. Data © OpenStreetMap contributors (ODbL).</p>}
            </div>
          )}
        </aside>
        <div className="atlas__map">
          {hint && <div className="atlas__hint">{hint}</div>}
          <MapCanvas center={PUNE} zoom={15} onMap={onMap} onStyle={addLayers} label="Map for the sweeping zone" testId="sweep-map" />
        </div>
      </div>
    </div>
  );
}
