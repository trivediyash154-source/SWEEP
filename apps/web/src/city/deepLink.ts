import { localProjection, nearestNode, type CityModel, type ProfileId } from '@sweep/engine';

/**
 * Route-lab links: `/workspace?from=<lat>,<lng>&to=<lat>,<lng>[&profile=car|truck|bicycle|foot]`. Each point snaps
 * to its nearest intersection; a point outside the bundled extract, or farther than SNAP_LIMIT_M from any
 * intersection, is refused with a plain message rather than snapped somewhere misleading.
 */

export const SNAP_LIMIT_M = 250;
const PROFILES: readonly ProfileId[] = ['car', 'truck', 'bicycle', 'foot'];

export interface RouteLink {
  from: number;
  to: number;
  profile: ProfileId | null;
  /** Distance from each requested point to the intersection used, in metres. */
  snapM: [number, number];
}

export type RouteLinkResult = { ok: true; link: RouteLink } | { ok: false; message: string };

const parsePoint = (s: string): [number, number] | null => {
  const parts = s.split(',');
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : null;
};

/** null when the URL has no route link; otherwise the snapped link or why it cannot be used. */
export function parseRouteLink(params: URLSearchParams, city: CityModel): RouteLinkResult | null {
  const from = params.get('from');
  const to = params.get('to');
  const profile = params.get('profile');
  if (from === null && to === null) return null;
  if (from === null || to === null) return { ok: false, message: 'This link needs both a start (from=) and a destination (to=), each as latitude,longitude.' };
  if (profile !== null && !PROFILES.includes(profile as ProfileId)) return { ok: false, message: `Unknown travel profile “${profile}”: use car, truck, bicycle or foot.` };
  const project = localProjection(city.origin[0], city.origin[1]);
  const r = city.region;
  const snap = (raw: string, label: string): { node: number; d: number } | string => {
    const p = parsePoint(raw);
    if (!p) return `The ${label} “${raw}” is not a latitude,longitude pair.`;
    const [x, y] = project([p[1], p[0]]);
    const node = nearestNode(city, x, y);
    const d = node < 0 ? Infinity : Math.hypot(city.nodeX[node]! - x, city.nodeY[node]! - y);
    const inside = x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
    if (!inside || d > SNAP_LIMIT_M) return `The ${label} (${p[0]}, ${p[1]}) is outside the bundled ${city.name} extract, so this lab cannot route it. Use the Directions page for places elsewhere.`;
    return { node, d };
  };
  const a = snap(from, 'start');
  if (typeof a === 'string') return { ok: false, message: a };
  const b = snap(to, 'destination');
  if (typeof b === 'string') return { ok: false, message: b };
  return { ok: true, link: { from: a.node, to: b.node, profile: (profile as ProfileId | null) ?? null, snapM: [a.d, b.d] } };
}
