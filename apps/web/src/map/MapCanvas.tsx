import { useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MLMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { usePrefs } from '../state/prefs';

/**
 * Base map for the map pages: OpenFreeMap vector styles (free, no key; data ©
 * OpenStreetMap contributors, tiles by OpenFreeMap / OpenMapTiles). If a style
 * cannot be loaded, the next one is tried, ending with plain OpenStreetMap
 * raster tiles. Pages add their own sources and layers through `onStyle`, which
 * runs again after every style change (theme switch or fallback).
 */

const OPENFREEMAP = 'https://tiles.openfreemap.org/styles';

const RASTER_FALLBACK: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#e8e4dc' } },
    { id: 'osm', type: 'raster', source: 'osm' },
  ],
};

export function styleCandidates(theme: 'velvet' | 'porcelain'): (string | StyleSpecification)[] {
  return theme === 'velvet' ? [`${OPENFREEMAP}/dark`, `${OPENFREEMAP}/positron`, RASTER_FALLBACK] : [`${OPENFREEMAP}/liberty`, `${OPENFREEMAP}/positron`, RASTER_FALLBACK];
}

export interface MapCanvasProps {
  /** [lng, lat] */
  center: [number, number];
  zoom: number;
  /** Called once with the map. */
  onMap?: (map: MLMap) => void;
  /** Called after every style load: add sources and layers here (idempotently). */
  onStyle?: (map: MLMap) => void;
  label: string;
  testId?: string;
}

export function MapCanvas({ center, zoom, onMap, onStyle, label, testId }: MapCanvasProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const onStyleRef = useRef(onStyle);
  onStyleRef.current = onStyle;
  const theme = usePrefs((s) => s.theme);
  const [failed, setFailed] = useState<string | null>(null);
  // Style fallback state: which candidate is loading, and whether it has loaded.
  const styleState = useRef({ attempt: 0, loaded: false });

  useEffect(() => {
    if (!ref.current) return;
    let map: MLMap;
    const candidates = styleCandidates(usePrefs.getState().theme);
    try {
      map = new maplibregl.Map({ container: ref.current, style: candidates[0]!, center, zoom, attributionControl: { compact: true }, maxPitch: 60 });
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
      return;
    }
    mapRef.current = map;
    (window as unknown as { __sweepMap?: MLMap }).__sweepMap = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.on('style.load', () => {
      styleState.current.loaded = true;
      onStyleRef.current?.(map);
    });
    map.on('error', () => {
      // Before a style has loaded, an error means it could not be fetched or parsed: try the next one.
      const st = styleState.current;
      if (st.loaded) return;
      const list = styleCandidates(usePrefs.getState().theme);
      if (st.attempt + 1 < list.length) {
        st.attempt++;
        map.setStyle(list[st.attempt]!);
      }
    });
    onMap?.(map);
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // The map is created once; center/zoom are initial values only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme switch: load the matching style; onStyle re-adds the page layers.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    styleState.current = { attempt: 0, loaded: false };
    mapRef.current?.setStyle(styleCandidates(theme)[0]!);
  }, [theme]);

  if (failed) {
    return (
      <div className="atlas__maperror" role="alert" data-testid={testId ? `${testId}-error` : undefined}>
        The map could not start in this browser ({failed}). It needs WebGL; try another browser or enable hardware acceleration.
      </div>
    );
  }
  return <div ref={ref} className="atlas__canvas" role="region" aria-label={label} data-testid={testId} />;
}

/** Add or replace a GeoJSON source's data. */
export function setGeoJson(map: MLMap, id: string, data: GeoJSON.FeatureCollection): void {
  const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
  if (src) src.setData(data);
  else if (map.isStyleLoaded() || map.loaded()) map.addSource(id, { type: 'geojson', data });
}

export const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
