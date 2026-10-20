import type { BBox } from '../geo.js';

/**
 * City datasets: real OpenStreetMap streets and building footprints for a
 * bounded area, with provenance. Three distinct models are derived from one
 * dataset and must not be confused:
 *
 *  - physical road SEGMENTS (this file): a piece of mapped road between two
 *    intersections, with its OSM attributes;
 *  - directed travel ARCS (p2p/network.ts): the permitted directions of
 *    travel over segments for one travel profile, with distance and time costs;
 *  - coverage EDGES (city/coverage.ts): the segments a service plan must
 *    cover, as a `Graph` for the postman solvers.
 */

/** Where a building height comes from. Only 'height' and 'levels' come from the source data. */
export type HeightSource = 'height' | 'levels' | 'estimate';
export const HEIGHT_SOURCES: readonly HeightSource[] = ['height', 'levels', 'estimate'];

/** Assumed storey height used to turn `building:levels` (and level estimates) into metres. */
export const STOREY_HEIGHT_M = 3.0;

/** OSM tags of a road way that SWEEP keeps (only keys present in the source are stored). */
export interface WayAttrs {
  id: number;
  highway: string;
  name?: string;
  ref?: string;
  /** Raw OSM `oneway` value. */
  oneway?: string;
  junction?: string;
  /** Raw OSM `maxspeed` value (for example "40", "30 mph", "IN:urban"). */
  maxspeed?: string;
  access?: string;
  vehicle?: string;
  motor_vehicle?: string;
  motorcar?: string;
  hgv?: string;
  bicycle?: string;
  foot?: string;
  'oneway:bicycle'?: string;
  surface?: string;
  lanes?: string;
  service?: string;
  bridge?: string;
  tunnel?: string;
  maxweight?: string;
  maxheight?: string;
}

export const KEPT_WAY_TAGS: readonly (keyof WayAttrs)[] = [
  'highway',
  'name',
  'ref',
  'oneway',
  'junction',
  'maxspeed',
  'access',
  'vehicle',
  'motor_vehicle',
  'motorcar',
  'hgv',
  'bicycle',
  'foot',
  'oneway:bicycle',
  'surface',
  'lanes',
  'service',
  'bridge',
  'tunnel',
  'maxweight',
  'maxheight',
];

/** A turn restriction mapped onto segments: travelling from `fromSeg` through node `via` into `toSeg`. */
export interface TurnRestriction {
  osmId: number;
  /** 'no' forbids exactly this turn; 'only' forbids every other turn from `fromSeg` at `via`. */
  kind: 'no' | 'only';
  /** Raw restriction value, for example "no_left_turn". */
  value: string;
  fromSeg: number;
  via: number;
  toSeg: number;
  /** Raw `except` tag (vehicle classes the restriction does not apply to). */
  except?: string;
}

export interface CityTileRecord {
  key: string;
  bbox: BBox;
  kind: 'streets' | 'buildings' | 'restrictions';
  status: 'ok' | 'missing';
  bytes?: number;
  osmBase?: string;
  endpoint?: string;
  fetchedAt?: string;
}

export interface CityProvenance {
  source: 'OpenStreetMap';
  attribution: string;
  license: string;
  licenseUrl: string;
  /** Overpass endpoint(s) the data was downloaded from. */
  endpoints: string[];
  /** Acquisition region (south, west, north, east), WGS84 degrees. */
  bbox: BBox;
  /** Earliest and latest `osm3s.timestamp_osm_base` of the downloaded tiles (database state). */
  osmBase: [string, string];
  /** Wall-clock times of the first and last successful download. */
  fetched: [string, string];
  builtAt: string;
  tiles: { total: number; ok: number; missing: string[] };
  queries: { streets: string; buildings: string; restrictions?: string };
  /** Every transformation applied between the raw data and this dataset. */
  transformations: string[];
  /** Every estimate or assumption, stated so it is never mistaken for measured data. */
  estimates: string[];
  /** Coverage gaps and other caveats. */
  limitations: string[];
}

export interface CityStats {
  areaKm2: number;
  nodes: number;
  segments: number;
  roadLengthKm: number;
  onewaySegments: number;
  ways: number;
  restrictions: { mapped: number; unsupported: number };
  buildings: {
    total: number;
    bySource: Record<HeightSource, number>;
    invalid: Record<string, number>;
    outsideRegion: number;
    duplicates: number;
  };
  roadClasses: Record<string, number>;
}

/**
 * Serialized dataset (JSON, format "sweep-city/1"). Coordinates are integer
 * decimetres in the local equirectangular frame of `origin` (x east, y south),
 * except node positions, which are also kept as WGS84 degrees × 1e7.
 */
export interface CityBundle {
  format: 'sweep-city/1';
  id: string;
  name: string;
  description: string;
  /** Projection origin [lon, lat]. */
  origin: [number, number];
  /** Optional focus point [lon, lat] (for example the area's landmark). */
  focus?: { lonlat: [number, number]; label: string };
  provenance: CityProvenance;
  stats: CityStats;
  network: {
    nodeOsm: number[];
    /** lon, lat × 1e7 interleaved. */
    nodeE7: number[];
    /** x, y decimetres interleaved. */
    nodeDm: number[];
    segU: number[];
    segV: number[];
    /** Length in decimetres (haversine along the mapped geometry). */
    segLenDm: number[];
    /** Index into `ways`. */
    segWay: number[];
    /** 1 when the segment may only be travelled u → v (one-way in mapped direction). */
    segOneway: number[];
    /** Offsets into `shapeDm` (pairs) for each segment's interior points; length segments + 1. */
    segShapeOff: number[];
    shapeDm: number[];
    ways: WayAttrs[];
    restrictions: TurnRestriction[];
  };
  buildings: {
    osm: number[];
    /** Offsets into `ringDm` (pairs); length buildings + 1. Rings are open (no repeated closing point). */
    ringOff: number[];
    ringDm: number[];
    /** Height in decimetres. */
    heightDm: number[];
    /** Index into HEIGHT_SOURCES. */
    heightSrc: number[];
    /** `building:levels` from the source, or -1. */
    levels: number[];
    /** Index into `kinds` (the OSM `building` value). */
    kind: number[];
    kinds: string[];
  };
}

/** Decoded, typed-array form used at runtime. Coordinates in metres. */
export interface CityModel {
  id: string;
  name: string;
  description: string;
  origin: [number, number];
  focus?: { lonlat: [number, number]; xy: [number, number]; label: string };
  provenance: CityProvenance;
  stats: CityStats;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** The acquisition region (provenance bbox) in local metres; streets may extend beyond it. */
  region: { minX: number; minY: number; maxX: number; maxY: number };
  nodeCount: number;
  nodeOsm: Float64Array;
  nodeLon: Float64Array;
  nodeLat: Float64Array;
  nodeX: Float64Array;
  nodeY: Float64Array;
  segCount: number;
  segU: Int32Array;
  segV: Int32Array;
  segLen: Float64Array;
  segWay: Int32Array;
  segOneway: Uint8Array;
  /** Offsets into segXY (points, not floats) including both endpoints; length segCount + 1. */
  segPtOff: Int32Array;
  segXY: Float64Array;
  ways: WayAttrs[];
  restrictions: TurnRestriction[];
  buildingCount: number;
  bOsm: Float64Array;
  bRingOff: Int32Array;
  bRingXY: Float32Array;
  bHeight: Float32Array;
  bHeightSrc: Uint8Array;
  bLevels: Int16Array;
  bKind: Uint16Array;
  bKinds: string[];
}
