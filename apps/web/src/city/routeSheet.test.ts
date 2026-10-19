import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCityBundle, rng, RoutingEngine } from '@sweep/engine';
import { routeSheet, turnCounts } from './routeSheet';

const BUNDLE = join(__dirname, '..', '..', 'public', 'cities', 'pune-bibwewadi.json');

describe.skipIf(!existsSync(BUNDLE))('route sheet on the real Pune network', () => {
  const city = decodeCityBundle(JSON.parse(readFileSync(BUNDLE, 'utf8')));
  const label = (s: number) => {
    const w = city.ways[city.segWay[s]!]!;
    return w.name ?? w.ref ?? `Unnamed ${w.highway}`;
  };

  it('classifies every junction exactly as the routing engine did, and its legs add up to the route', () => {
    const engine = new RoutingEngine(city, 'car');
    const r = rng(7);
    let checked = 0;
    for (let i = 0; i < 60; i++) {
      const q = { origin: Math.floor(r() * city.nodeCount), destination: Math.floor(r() * city.nodeCount), objective: 'time' as const };
      const res = engine.query('dijkstra', q).result;
      if (!res.found || res.arcs.length < 2) continue;
      checked++;
      expect(turnCounts(city, res.arcs)).toEqual(res.turns);
      const legs = routeSheet(city, res.arcs, label);
      expect(legs[0]!.turn).toBe('start');
      expect(legs.reduce((a, l) => a + l.segments, 0)).toBe(res.arcs.length);
      expect(Math.abs(legs.reduce((a, l) => a + l.distanceM, 0) - res.distanceM)).toBeLessThan(1e-6);
      expect(Math.abs(legs[legs.length - 1]!.cumulativeM - res.distanceM)).toBeLessThan(1e-6);
      // Consecutive legs are on different streets unless separated by a U-turn.
      for (let k = 1; k < legs.length; k++) if (legs[k]!.turn !== 'uturn') expect(legs[k]!.street).not.toBe(legs[k - 1]!.street);
    }
    expect(checked).toBeGreaterThan(20);
  });
});
