import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCityBundle } from '@sweep/engine';
import { parseRouteLink, SNAP_LIMIT_M } from './deepLink';

const BUNDLE = join(__dirname, '..', '..', 'public', 'cities', 'pune-bibwewadi.json');

describe.skipIf(!existsSync(BUNDLE))('route-lab links on the real Pune extract', () => {
  const city = decodeCityBundle(JSON.parse(readFileSync(BUNDLE, 'utf8')));
  const at = (n: number): string => `${city.nodeLat[n]},${city.nodeLon[n]}`;
  const q = (s: string) => new URLSearchParams(s);

  it('is absent when the URL has no route link', () => {
    expect(parseRouteLink(q(''), city)).toBeNull();
    expect(parseRouteLink(q('mode=coverage'), city)).toBeNull();
  });

  it('snaps intersections given by their own coordinates to themselves, with the profile', () => {
    const a = 10;
    const b = Math.floor(city.nodeCount / 2);
    const r = parseRouteLink(q(`from=${at(a)}&to=${at(b)}&profile=truck`), city);
    expect(r).toMatchObject({ ok: true, link: { from: a, to: b, profile: 'truck' } });
    if (r?.ok) for (const d of r.link.snapM) expect(d).toBeLessThan(1);
  });

  it('snaps a point near a street to the nearest intersection, without a profile', () => {
    const n = 100;
    // About 20 m north-east of intersection n.
    const r = parseRouteLink(q(`from=${city.nodeLat[n]! + 0.00013},${city.nodeLon[n]! + 0.00013}&to=${at(200)}`), city);
    expect(r?.ok).toBe(true);
    if (r?.ok) {
      expect(r.link.profile).toBeNull();
      expect(r.link.snapM[0]).toBeLessThan(SNAP_LIMIT_M);
    }
  });

  it('refuses points outside the extract, malformed points, half links and unknown profiles', () => {
    expect(parseRouteLink(q(`from=19.0760,72.8777&to=${at(5)}`), city)).toMatchObject({ ok: false, message: expect.stringMatching(/outside the bundled/) });
    expect(parseRouteLink(q(`from=abc&to=${at(5)}`), city)).toMatchObject({ ok: false, message: expect.stringMatching(/not a latitude,longitude/) });
    expect(parseRouteLink(q(`from=${at(5)}`), city)).toMatchObject({ ok: false, message: expect.stringMatching(/needs both/) });
    expect(parseRouteLink(q(`from=${at(5)}&to=${at(6)}&profile=boat`), city)).toMatchObject({ ok: false, message: expect.stringMatching(/Unknown travel profile/) });
  });
});
