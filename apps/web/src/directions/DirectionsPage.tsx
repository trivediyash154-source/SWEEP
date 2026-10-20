import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import maplibregl, { type Map as MLMap } from 'maplibre-gl';
import { SiteNav } from '../components/SiteNav';
import { MapCanvas, setGeoJson, EMPTY_FC } from '../map/MapCanvas';
import { PlaceSearch } from '../map/PlaceSearch';
import { describePoint, formatLatLng, parseLatLng, type GeoPlace } from '../lib/geocode';
import { DirectionsError, fetchDirections, formatTravelDistance, formatTravelTime, type DirectionsResult, type LngLat, type TravelMode } from '../lib/directions';
import '../styles/atlas.css';

interface Endpoint {
  point: LngLat;
  label: string;
}

const MODES: [TravelMode, string][] = [
  ['car', 'Car'],
  ['bike', 'Bicycle'],
  ['foot', 'Walking'],
];
const PUNE: [number, number] = [73.8567, 18.5204];
/** SWEEP's offline Pune extract (south, west, north, east), where its own exact engine runs. */
const PUNE_EXTRACT = [18.445, 73.85, 18.481, 73.888] as const;
const inExtract = (p: LngLat): boolean => p.lat >= PUNE_EXTRACT[0] && p.lat <= PUNE_EXTRACT[2] && p.lng >= PUNE_EXTRACT[1] && p.lng <= PUNE_EXTRACT[3];

function readPoint(v: string | null): LngLat | null {
  return v ? parseLatLng(v.replace(',', ', ')) : null;
}
const writePoint = (p: LngLat): string => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

export default function DirectionsPage() {
  const [params, setParams] = useSearchParams();
  const [from, setFrom] = useState<Endpoint | null>(() => {
    const p = readPoint(params.get('from'));
    return p ? { point: p, label: formatLatLng(p) } : null;
  });
  const [to, setTo] = useState<Endpoint | null>(() => {
    const p = readPoint(params.get('to'));
    return p ? { point: p, label: formatLatLng(p) } : null;
  });
  const [mode, setMode] = useState<TravelMode>(() => {
    const m = params.get('mode');
    return m === 'bike' || m === 'foot' ? m : 'car';
  });
  const [active, setActive] = useState<'from' | 'to'>(() => (readPoint(params.get('from')) ? 'to' : 'from'));
  const [result, setResult] = useState<DirectionsResult | null>(null);
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const markers = useRef<{ from: maplibregl.Marker | null; to: maplibregl.Marker | null; step: maplibregl.Marker | null }>({ from: null, to: null, step: null });
  const activeRef = useRef(active);
  activeRef.current = active;

  const near = useCallback((): LngLat | null => {
    const c = mapRef.current?.getCenter();
    return c ? { lng: c.lng, lat: c.lat } : { lng: PUNE[0], lat: PUNE[1] };
  }, []);

  // Labels for points that came from the URL or a map click.
  const labelPoint = useCallback(async (which: 'from' | 'to', p: LngLat) => {
    const label = await describePoint(p);
    const set = which === 'from' ? setFrom : setTo;
    set((cur) => (cur && cur.point.lat === p.lat && cur.point.lng === p.lng ? { point: p, label } : cur));
  }, []);
  useEffect(() => {
    if (from && from.label === formatLatLng(from.point)) void labelPoint('from', from.point);
    if (to && to.label === formatLatLng(to.point)) void labelPoint('to', to.point);
    // Only once, for the points read from the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setEndpoint = useCallback(
    (which: 'from' | 'to', e: Endpoint) => {
      (which === 'from' ? setFrom : setTo)(e);
      if (which === 'from' && !to) setActive('to');
    },
    [to],
  );

  // Keep the URL shareable.
  useEffect(() => {
    const next = new URLSearchParams();
    if (from) next.set('from', writePoint(from.point));
    if (to) next.set('to', writePoint(to.point));
    if (mode !== 'car') next.set('mode', mode);
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [from, to, mode, params, setParams]);

  // Fetch directions whenever both ends or the mode change.
  useEffect(() => {
    if (!from || !to) {
      setResult(null);
      setStatus('idle');
      return;
    }
    const c = new AbortController();
    setStatus('loading');
    setError(null);
    fetchDirections(mode, from.point, to.point, c.signal)
      .then((r) => {
        setResult(r);
        setSelected(0);
        setStatus('done');
      })
      .catch((err: unknown) => {
        if (c.signal.aborted) return;
        setResult(null);
        setStatus('error');
        setError(err instanceof DirectionsError ? err.message : `Directions failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    return () => c.abort();
  }, [from, to, mode]);

  // Draw routes and markers.
  const routeData = useMemo<GeoJSON.FeatureCollection>(() => {
    if (!result) return EMPTY_FC;
    return {
      type: 'FeatureCollection',
      features: result.routes.map((r, i) => ({ type: 'Feature', properties: { idx: i, selected: i === selected ? 1 : 0 }, geometry: { type: 'LineString', coordinates: r.coordinates } })),
    };
  }, [result, selected]);
  const routeDataRef = useRef(routeData);
  routeDataRef.current = routeData;

  const addLayers = useCallback((map: MLMap) => {
    if (!map.getSource('routes')) map.addSource('routes', { type: 'geojson', data: routeDataRef.current });
    const before = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id;
    if (!map.getLayer('route-alt')) map.addLayer({ id: 'route-alt', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#8a8f99', 'line-width': 5, 'line-opacity': 0.75 } }, before);
    if (!map.getLayer('route-casing')) map.addLayer({ id: 'route-casing', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0b3d91', 'line-width': 9 } }, before);
    if (!map.getLayer('route-main')) map.addLayer({ id: 'route-main', type: 'line', source: 'routes', filter: ['==', ['get', 'selected'], 1], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#3d8bfd', 'line-width': 5.5 } }, before);
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (map && map.getSource('routes')) setGeoJson(map, 'routes', routeData);
  }, [routeData]);

  // Fit the view to a new result.
  useEffect(() => {
    const map = mapRef.current;
    const r = result?.routes[0];
    if (!map || !r || r.coordinates.length < 2) return;
    const b = new maplibregl.LngLatBounds(r.coordinates[0], r.coordinates[0]);
    for (const c of r.coordinates) b.extend(c);
    map.fitBounds(b, { padding: 60, duration: 600, maxZoom: 16 });
  }, [result]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const place = (which: 'from' | 'to', e: Endpoint | null) => {
      const m = markers.current[which];
      if (!e) {
        m?.remove();
        markers.current[which] = null;
        return;
      }
      if (m) m.setLngLat([e.point.lng, e.point.lat]);
      else {
        const mk = new maplibregl.Marker({ color: which === 'from' ? '#2fbf71' : '#e5484d', draggable: true }).setLngLat([e.point.lng, e.point.lat]).addTo(map);
        mk.getElement().setAttribute('data-testid', `marker-${which}`);
        mk.getElement().setAttribute('aria-label', which === 'from' ? 'Start (drag to move)' : 'Destination (drag to move)');
        mk.on('dragend', () => {
          const ll = mk.getLngLat();
          const p = { lng: ll.lng, lat: ll.lat };
          (which === 'from' ? setFrom : setTo)({ point: p, label: formatLatLng(p) });
          void labelPoint(which, p);
        });
        markers.current[which] = mk;
      }
    };
    place('from', from);
    place('to', to);
  }, [from, to, labelPoint]);

  const onMap = useCallback(
    (map: MLMap) => {
      mapRef.current = map;
      map.on('click', (e) => {
        // A click on an alternative route selects it instead of moving a point.
        if (map.getLayer('route-alt') && map.queryRenderedFeatures(e.point, { layers: ['route-alt'] }).length) return;
        const p = { lng: e.lngLat.lng, lat: e.lngLat.lat };
        const which = activeRef.current;
        (which === 'from' ? setFrom : setTo)({ point: p, label: formatLatLng(p) });
        if (which === 'from') setActive('to');
        void labelPoint(which, p);
      });
      map.on('click', 'route-alt', (e) => {
        const idx = Number(e.features?.[0]?.properties?.idx);
        if (Number.isFinite(idx)) setSelected(idx);
      });
      map.on('mouseenter', 'route-alt', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'route-alt', () => (map.getCanvas().style.cursor = ''));
    },
    [labelPoint],
  );

  const showStep = (loc: [number, number]) => {
    const map = mapRef.current;
    if (!map) return;
    markers.current.step?.remove();
    markers.current.step = new maplibregl.Marker({ color: '#f0c27a', scale: 0.7 }).setLngLat(loc).addTo(map);
    map.easeTo({ center: loc, zoom: Math.max(map.getZoom(), 16), duration: 500 });
  };

  const locate = () => {
    if (!navigator.geolocation) return setError('This browser cannot share its location.');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const p = { lng: pos.coords.longitude, lat: pos.coords.latitude };
        setEndpoint('from', { point: p, label: 'Your location' });
        mapRef.current?.easeTo({ center: [p.lng, p.lat], zoom: 14 });
      },
      () => setError('Location permission was denied or the position is unavailable.'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const route = result?.routes[selected] ?? null;
  const both = from && to;
  const hint = !from ? 'Search for a start, or click the map to set it' : !to ? 'Now search for a destination, or click the map' : null;

  return (
    <div className="atlas">
      <SiteNav />
      <div className="atlas__body">
        <aside className="atlas__panel" aria-label="Directions">
          <h1>Directions</h1>
          <p className="atlas__lede">Anywhere in Pune, India or the world: search two places or click the map, then pick how you travel.</p>
          <div className="atlas__section">
            <PlaceSearch label="Start" placeholder="Start: a place, address or lat, lng" value={from?.label ?? ''} near={near} dot="from" active={active === 'from'} onFocus={() => setActive('from')} onPick={(p: GeoPlace) => { setEndpoint('from', { point: { lng: p.lng, lat: p.lat }, label: p.label }); mapRef.current?.easeTo({ center: [p.lng, p.lat], zoom: Math.max(mapRef.current.getZoom(), 13) }); }} testId="dir-from" />
            <PlaceSearch label="Destination" placeholder="Destination" value={to?.label ?? ''} near={near} dot="to" active={active === 'to'} onFocus={() => setActive('to')} onPick={(p: GeoPlace) => setEndpoint('to', { point: { lng: p.lng, lat: p.lat }, label: p.label })} testId="dir-to" />
            <div className="atlas__row">
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => { setFrom(to); setTo(from); }} disabled={!from && !to} data-testid="dir-swap">
                ⇅ Swap
              </button>
              <button type="button" className="btn btn--quiet btn--sm" onClick={locate} data-testid="dir-locate">
                ◎ My location
              </button>
              <button type="button" className="btn btn--quiet btn--sm" onClick={() => { setFrom(null); setTo(null); setActive('from'); setError(null); }} disabled={!from && !to} data-testid="dir-clear">
                Clear
              </button>
            </div>
          </div>
          <div className="segmented" role="group" aria-label="Travel mode">
            {MODES.map(([m, label]) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)} data-testid={`dir-mode-${m}`}>
                {label}
              </button>
            ))}
          </div>

          {status === 'loading' && <p className="atlas__status" role="status">Finding routes…</p>}
          {error && (
            <p className="atlas__error" role="alert" data-testid="dir-error">
              {error}
            </p>
          )}

          {result && route && (
            <div className="atlas__section" data-testid="dir-result">
              <h2>{result.routes.length > 1 ? `${result.routes.length} routes` : 'Route'}</h2>
              {result.routes.map((r, i) => (
                <button key={i} type="button" className="route-card" aria-pressed={i === selected} onClick={() => setSelected(i)} data-testid={`dir-route-${i}`}>
                  <span className="route-card__time" data-testid={i === selected ? 'dir-time' : undefined}>
                    {formatTravelTime(r.durationS)}
                  </span>
                  <span className="route-card__dist" data-testid={i === selected ? 'dir-distance' : undefined}>
                    {formatTravelDistance(r.distanceM)}
                  </span>
                  {r.via && <span className="route-card__via">via {r.via}</span>}
                </button>
              ))}
              <h2>Turn by turn</h2>
              <ol className="steps" data-testid="dir-steps">
                {route.steps.map((s, i) => (
                  <li key={i}>
                    <button type="button" onClick={() => showStep(s.location)}>
                      <span>{s.instruction}</span>
                      <span className="steps__dist">{s.type === 'arrive' ? '' : formatTravelDistance(s.distanceM)}</span>
                    </button>
                  </li>
                ))}
              </ol>
              <p className="atlas__note" data-testid="dir-provider">
                Route computed by{' '}
                <a href={result.provider.homepage} target="_blank" rel="noreferrer">
                  {result.provider.name}
                </a>{' '}
                on OpenStreetMap data, not by SWEEP's own engine. Travel times are the service's free-flow estimates; live traffic is not included.
                {result.failed.length > 0 && ` Tried first: ${result.failed.map((f) => `${f.provider.name} (${f.reason})`).join('; ')}.`}
              </p>
              {both && inExtract(from.point) && inExtract(to.point) && (
                <p className="atlas__note" data-testid="dir-extract">
                  Both points are inside SWEEP's offline Pune extract around VIT. There, the{' '}
                  <Link to="/workspace">Pune algorithm lab</Link> computes the same kind of trip with five exact algorithms (Dijkstra, A*, bidirectional, ALT, contraction hierarchies) and checks every route independently.
                </p>
              )}
            </div>
          )}

          {!result && status !== 'loading' && !error && (
            <div className="atlas__section">
              <h2>Try</h2>
              <div className="atlas__row">
                <button type="button" className="btn btn--ghost btn--sm" data-testid="dir-example" onClick={() => { setFrom({ point: { lat: 18.4636, lng: 73.8682 }, label: 'Vishwakarma Institute of Technology, Bibwewadi' }); setTo({ point: { lat: 18.5195, lng: 73.8553 }, label: 'Shaniwar Wada' }); }}>
                  VIT Bibwewadi → Shaniwar Wada
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setFrom({ point: { lat: 18.5289, lng: 73.8744 }, label: 'Pune Railway Station' }); setTo({ point: { lat: 18.5793, lng: 73.9089 }, label: 'Pune Airport' }); }}>
                  Railway station → Airport
                </button>
              </div>
            </div>
          )}
          <p className="atlas__note">Search by Photon and Nominatim; map by OpenFreeMap; data © OpenStreetMap contributors (ODbL).</p>
        </aside>
        <div className="atlas__map">
          {hint && <div className="atlas__hint">{hint}</div>}
          <MapCanvas center={from ? [from.point.lng, from.point.lat] : PUNE} zoom={from ? 13 : 11.5} onMap={onMap} onStyle={addLayers} label="Map for directions" testId="dir-map" />
        </div>
      </div>
    </div>
  );
}
