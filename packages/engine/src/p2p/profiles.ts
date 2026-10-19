import type { WayAttrs } from '../city/types.js';

/**
 * Travel profiles for point-to-point routing.
 *
 * Everything here is either read from OpenStreetMap tags or an ASSUMPTION
 * stated below and returned by profileAssumptions(). Nothing in this module
 * models live traffic, legal vehicle dimensions or time-of-day rules unless a
 * tag says so.
 *
 * Speeds (free-flow, km/h, by OSM highway class) — ASSUMPTIONS for urban Pune:
 *   class            car  truck  bicycle  foot
 *   motorway          80    60      –       –
 *   motorway_link     50    40      –       –
 *   trunk             50    40     15     4.8
 *   trunk_link        40    30     15     4.8
 *   primary           40    32     15     4.8
 *   primary_link      30    25     15     4.8
 *   secondary         35    28     15     4.8
 *   secondary_link    30    25     15     4.8
 *   tertiary          30    25     15     4.8
 *   tertiary_link     25    20     15     4.8
 *   unclassified      25    20     15     4.8
 *   residential       20    16     14     4.8
 *   living_street     10     8     10     4.8
 *   service           15    12     12     4.8
 * An explicit, parseable `maxspeed` replaces the class speed for car and truck
 * (capped at 100 and 60 km/h); for bicycles it only lowers the speed. Walking
 * ignores `maxspeed`.
 *
 * Turn penalties (time objective only; India drives on the LEFT, so a right
 * turn crosses oncoming traffic) — ASSUMPTIONS, seconds:
 *   straight (|angle| < 30°) 0 · left turn 4 · right turn 10 · U-turn 20.
 * A U-turn (back along the same segment) is permitted only where the arriving
 * direction has no other permitted continuation (a dead end, or a node where
 * every other road is closed, one-way the wrong way or not accessible);
 * elsewhere it is not allowed. Walking has no turn penalties and may turn back
 * anywhere.
 */

export type ProfileId = 'car' | 'bicycle' | 'foot' | 'truck';
export type Objective = 'time' | 'distance';
export const PROFILES: readonly ProfileId[] = ['car', 'bicycle', 'foot', 'truck'];

export interface TruckVehicle {
  /** Gross weight, tonnes (compared with `maxweight`). */
  weightT: number;
  /** Height, metres (compared with `maxheight`). */
  heightM: number;
}
export const DEFAULT_TRUCK: Readonly<TruckVehicle> = { weightT: 12, heightM: 3.8 };

export interface TurnPenalties {
  straight: number;
  left: number;
  right: number;
  uturn: number;
}

export interface ProfileSpec {
  id: ProfileId;
  label: string;
  /** Allowed highway classes and their free-flow speed (km/h). */
  speeds: Readonly<Record<string, number>>;
  maxspeed: 'replace' | 'lower-only' | 'ignore';
  speedCapKmh: number;
  obeysOneway: boolean;
  obeysRestrictions: boolean;
  /** Turn penalties in seconds, or null when the profile has none. */
  turns: TurnPenalties | null;
  /** U-turn permitted only where no other continuation exists (true), or anywhere (false). */
  uturnOnlyAtDeadEnds: boolean;
  /** OSM access keys from general to specific; the most specific tagged value decides. */
  accessKeys: readonly string[];
  /** Keys whose value "-" etc. exempt from restrictions (`except`). */
  exceptKeys: readonly string[];
}

const TURNS: TurnPenalties = { straight: 0, left: 4, right: 10, uturn: 20 };

const CAR_SPEEDS: Record<string, number> = {
  motorway: 80,
  motorway_link: 50,
  trunk: 50,
  trunk_link: 40,
  primary: 40,
  primary_link: 30,
  secondary: 35,
  secondary_link: 30,
  tertiary: 30,
  tertiary_link: 25,
  unclassified: 25,
  residential: 20,
  living_street: 10,
  service: 15,
};
const TRUCK_SPEEDS: Record<string, number> = {
  motorway: 60,
  motorway_link: 40,
  trunk: 40,
  trunk_link: 30,
  primary: 32,
  primary_link: 25,
  secondary: 28,
  secondary_link: 25,
  tertiary: 25,
  tertiary_link: 20,
  unclassified: 20,
  residential: 16,
  living_street: 8,
  service: 12,
};
const BIKE_SPEEDS: Record<string, number> = {
  trunk: 15,
  trunk_link: 15,
  primary: 15,
  primary_link: 15,
  secondary: 15,
  secondary_link: 15,
  tertiary: 15,
  tertiary_link: 15,
  unclassified: 15,
  residential: 14,
  living_street: 10,
  service: 12,
};
const FOOT_SPEEDS: Record<string, number> = Object.fromEntries(Object.keys(BIKE_SPEEDS).map((k) => [k, 4.8]));

export const PROFILE_SPECS: Readonly<Record<ProfileId, ProfileSpec>> = {
  car: {
    id: 'car',
    label: 'Car',
    speeds: CAR_SPEEDS,
    maxspeed: 'replace',
    speedCapKmh: 100,
    obeysOneway: true,
    obeysRestrictions: true,
    turns: TURNS,
    uturnOnlyAtDeadEnds: true,
    accessKeys: ['access', 'vehicle', 'motor_vehicle', 'motorcar'],
    exceptKeys: ['motorcar', 'motor_vehicle', 'vehicle'],
  },
  truck: {
    id: 'truck',
    label: 'Truck',
    speeds: TRUCK_SPEEDS,
    maxspeed: 'replace',
    speedCapKmh: 60,
    obeysOneway: true,
    obeysRestrictions: true,
    turns: TURNS,
    uturnOnlyAtDeadEnds: true,
    accessKeys: ['access', 'vehicle', 'motor_vehicle', 'hgv'],
    exceptKeys: ['hgv', 'motor_vehicle', 'vehicle'],
  },
  bicycle: {
    id: 'bicycle',
    label: 'Bicycle',
    speeds: BIKE_SPEEDS,
    maxspeed: 'lower-only',
    speedCapKmh: 20,
    obeysOneway: true,
    obeysRestrictions: true,
    turns: TURNS,
    uturnOnlyAtDeadEnds: true,
    accessKeys: ['access', 'vehicle', 'bicycle'],
    exceptKeys: ['bicycle', 'vehicle'],
  },
  foot: {
    id: 'foot',
    label: 'Walking',
    speeds: FOOT_SPEEDS,
    maxspeed: 'ignore',
    speedCapKmh: 4.8,
    obeysOneway: false,
    obeysRestrictions: false,
    turns: null,
    uturnOnlyAtDeadEnds: false,
    accessKeys: ['access', 'foot'],
    exceptKeys: [],
  },
};

const DENY = new Set(['no', 'private', 'agricultural', 'forestry', 'emergency', 'military', 'permit', 'discouraged_no']);
const DESTINATION = new Set(['destination', 'delivery', 'customers']);

export type AccessResult = { allowed: false; reason: string } | { allowed: true; destinationOnly: boolean };

/** Most specific access value among the profile's keys decides (OSM access hierarchy). */
export function accessFor(way: WayAttrs, p: ProfileSpec): AccessResult {
  if (p.speeds[way.highway] === undefined) return { allowed: false, reason: `highway=${way.highway} not used by ${p.label.toLowerCase()} profile` };
  let value: string | undefined;
  let key = '';
  for (const k of p.accessKeys) {
    const v = (way as unknown as Record<string, string | undefined>)[k];
    if (v !== undefined) {
      value = v.trim().toLowerCase();
      key = k;
    }
  }
  if (value === undefined) return { allowed: true, destinationOnly: false };
  if (DENY.has(value)) return { allowed: false, reason: `${key}=${value}` };
  return { allowed: true, destinationOnly: DESTINATION.has(value) };
}

/** Parse an OSM maxspeed value to km/h, or null (implicit values like "IN:urban", "none", lists, out of range). */
export function parseMaxspeed(raw: string | undefined): number | null {
  if (raw == null) return null;
  const s = raw.trim().toLowerCase();
  let m = /^(\d+(?:\.\d+)?)\s*(km\/h|kmh|kph)?$/.exec(s);
  let v: number | null = null;
  if (m) v = Number(m[1]);
  else if ((m = /^(\d+(?:\.\d+)?)\s*mph$/.exec(s))) v = Number(m[1]) * 1.609344;
  if (v === null || !Number.isFinite(v) || v < 5 || v > 150) return null;
  return v;
}

export interface SpeedResult {
  kmh: number;
  /** 'maxspeed' when an OSM maxspeed tag set (or lowered) the speed, 'default' when it is the class assumption. */
  source: 'maxspeed' | 'default';
}

export function speedFor(way: WayAttrs, p: ProfileSpec): SpeedResult {
  const base = p.speeds[way.highway] ?? 0;
  if (p.maxspeed === 'ignore') return { kmh: base, source: 'default' };
  const ms = parseMaxspeed(way.maxspeed);
  if (ms === null) return { kmh: Math.min(base, p.speedCapKmh), source: 'default' };
  if (p.maxspeed === 'replace') return { kmh: Math.min(ms, p.speedCapKmh), source: 'maxspeed' };
  return ms < base ? { kmh: ms, source: 'maxspeed' } : { kmh: Math.min(base, p.speedCapKmh), source: 'default' };
}

/** Does a one-way segment bind this profile? */
export function onewayApplies(way: WayAttrs, p: ProfileSpec): boolean {
  if (!p.obeysOneway) return false;
  if (p.id === 'bicycle' && way['oneway:bicycle']?.trim().toLowerCase() === 'no') return false;
  return true;
}

/** Is a restriction with this `except` value binding for the profile? */
export function restrictionApplies(except: string | undefined, p: ProfileSpec): boolean {
  if (!p.obeysRestrictions) return false;
  if (!except) return true;
  const ex = except.split(';').map((x) => x.trim().toLowerCase());
  return !p.exceptKeys.some((k) => ex.includes(k));
}

/** Parse maxweight (t) / maxheight (m); null when absent or unparseable. */
export function parseLimit(raw: string | undefined, unit: 't' | 'm'): number | null {
  if (raw == null) return null;
  const s = raw.trim().toLowerCase();
  const m = unit === 't' ? /^(\d+(?:\.\d+)?)\s*(t)?$/.exec(s) : /^(\d+(?:\.\d+)?)\s*(m)?$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) && v > 0 && v < 1000 ? v : null;
}

/** Truck limits: only where maxweight / maxheight tags exist. */
export function truckLimitsAllow(way: WayAttrs, v: TruckVehicle): { allowed: boolean; reason?: string } {
  const w = parseLimit(way.maxweight, 't');
  if (w !== null && v.weightT > w) return { allowed: false, reason: `maxweight=${way.maxweight} < ${v.weightT} t` };
  const h = parseLimit(way.maxheight, 'm');
  if (h !== null && v.heightM > h) return { allowed: false, reason: `maxheight=${way.maxheight} < ${v.heightM} m` };
  return { allowed: true };
}

export type TurnKind = 'straight' | 'left' | 'right' | 'uturn';

/**
 * Classify a turn from incoming direction (dx1, dy1) to outgoing (dx2, dy2),
 * both in the city frame (x east, y SOUTH). |angle| < 30° is straight.
 */
export function classifyTurn(dx1: number, dy1: number, dx2: number, dy2: number): Exclude<TurnKind, 'uturn'> {
  // Convert to y-up for the usual orientation of the cross product.
  const ax = dx1;
  const ay = -dy1;
  const bx = dx2;
  const by = -dy2;
  const cross = ax * by - ay * bx;
  const dot = ax * bx + ay * by;
  const angle = Math.atan2(cross, dot); // > 0: counter-clockwise = left
  if (Math.abs(angle) < (30 * Math.PI) / 180) return 'straight';
  return angle > 0 ? 'left' : 'right';
}

export function profileAssumptions(id: ProfileId, vehicle: TruckVehicle = DEFAULT_TRUCK): string[] {
  const p = PROFILE_SPECS[id];
  const out: string[] = [];
  out.push(
    `Free-flow speeds by road class are assumptions (${Object.entries(p.speeds)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')} km/h); there is no live or time-of-day traffic.`,
  );
  if (p.maxspeed === 'replace') out.push(`A parseable OSM maxspeed replaces the class speed (capped at ${p.speedCapKmh} km/h); implicit values such as "IN:urban" are not interpreted.`);
  if (p.maxspeed === 'lower-only') out.push(`OSM maxspeed only lowers the cycling speed (cap ${p.speedCapKmh} km/h).`);
  if (p.maxspeed === 'ignore') out.push('Walking speed is a constant 4.8 km/h.');
  out.push(`Access follows the OSM hierarchy ${p.accessKeys.join(' → ')}; no, private, agricultural, forestry, emergency, military and permit deny access; destination/delivery/customers are allowed and flagged.`);
  out.push(p.obeysOneway ? `One-way streets are obeyed${id === 'bicycle' ? ' (except where oneway:bicycle=no)' : ''}.` : 'One-way streets do not restrict walking.');
  out.push(p.obeysRestrictions ? `Mapped via-node turn restrictions are obeyed (unless their except tag names ${p.exceptKeys.join('/')}); via-way restrictions are not modelled.` : 'Turn restrictions do not apply to walking.');
  if (p.turns) {
    out.push(`Turn penalties (time objective only, left-hand traffic): straight ${p.turns.straight} s, left ${p.turns.left} s, right ${p.turns.right} s, U-turn ${p.turns.uturn} s; U-turns only where no other continuation is permitted.`);
  } else out.push('No turn penalties; turning back is allowed anywhere.');
  out.push('Footpaths, cycleways and pedestrian-only ways were not acquired for this dataset; all profiles use the road network.');
  if (id === 'truck') {
    out.push(
      `Truck size/weight limits are modelled ONLY where maxweight/maxheight tags exist, compared with a ${vehicle.weightT} t, ${vehicle.heightM} m vehicle. Most roads have no such tags, so legal truck access is NOT verified; no time-window or permit rules are modelled.`,
    );
  }
  return out;
}
