import { afterEach, describe, expect, it, vi } from 'vitest';
import { compass, DirectionsError, fetchDirections, formatTravelDistance, formatTravelTime, instructionFor, osrmRouteUrl, parseOsrmRoutes, DIRECTIONS_PROVIDERS } from './directions';

// A response in the OSRM /route v1 format (test double, not a real route).
const osrm = {
  code: 'Ok',
  routes: [
    {
      distance: 5230.4,
      duration: 812.6,
      geometry: { type: 'LineString', coordinates: [[73.8682, 18.4636], [73.86, 18.49], [73.8553, 18.5195]] },
      legs: [
        {
          steps: [
            { name: 'Bibwewadi Road', distance: 900, duration: 120, maneuver: { type: 'depart', bearing_after: 350, location: [73.8682, 18.4636] } },
            { name: 'Satara Road', distance: 3000, duration: 400, maneuver: { type: 'turn', modifier: 'left', location: [73.86, 18.47] } },
            { name: 'Satara Road', distance: 1, duration: 1, maneuver: { type: 'roundabout', exit: 2, location: [73.858, 18.5] } },
            { name: '', distance: 1300, duration: 290, maneuver: { type: 'fork', modifier: 'slight right', location: [73.857, 18.51] } },
            { name: 'Bajirao Road', distance: 0, duration: 0, maneuver: { type: 'arrive', modifier: 'right', location: [73.8553, 18.5195] } },
          ],
        },
      ],
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('OSRM directions', () => {
  it('builds the request URL in lng,lat order with steps and alternatives', () => {
    const u = osrmRouteUrl(DIRECTIONS_PROVIDERS.car[0]!, { lng: 73.8682, lat: 18.4636 }, { lng: 73.8553, lat: 18.5195 });
    expect(u).toBe('https://routing.openstreetmap.de/routed-car/route/v1/driving/73.868200,18.463600;73.855300,18.519500?overview=full&geometries=geojson&steps=true&alternatives=true');
  });

  it('turns manoeuvres into plain instructions', () => {
    expect(compass(350)).toBe('north');
    expect(compass(95)).toBe('east');
    const r = parseOsrmRoutes(osrm)[0]!;
    expect(r.steps.map((s) => s.instruction)).toEqual(['Head north on Bibwewadi Road', 'Turn left onto Satara Road', 'At the roundabout, take the second exit onto Satara Road', 'Keep right at the fork', 'Arrive at your destination, on the right']);
    expect(r.distanceM).toBe(5230.4);
    expect(r.coordinates).toHaveLength(3);
    expect(r.via).toBe('Satara Road, Bibwewadi Road');
    expect(instructionFor({ name: 'FC Road', maneuver: { type: 'continue', modifier: 'uturn' } })).toBe('Make a U-turn onto FC Road');
    expect(instructionFor({ name: 'JM Road', maneuver: { type: 'end of road', modifier: 'right' } })).toBe('At the end of the road, turn right onto JM Road');
  });

  it('reports "no route" plainly and rejects malformed answers', () => {
    expect(() => parseOsrmRoutes({ code: 'NoRoute', message: 'Impossible route' })).toThrow(/No route connects/);
    expect(() => parseOsrmRoutes({ code: 'InvalidQuery' })).toThrow(DirectionsError);
    expect(() => parseOsrmRoutes(null)).toThrow(DirectionsError);
  });

  it('falls back to the next server when one is busy, and names the one that answered', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://routing.openstreetmap.de')) return new Response('busy', { status: 503 });
      return new Response(JSON.stringify(osrm), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const res = await fetchDirections('car', { lng: 73.1, lat: 18.1 }, { lng: 73.2, lat: 18.2 });
    expect(calls).toHaveLength(2);
    expect(res.provider.id).toBe('osrm-demo-car');
    expect(res.failed.map((f) => f.reason)).toEqual(['busy (HTTP 503)']);
    expect(res.routes[0]!.durationS).toBe(812.6);
  });

  it('says so when no server answers, and stops at a genuine "no route"', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(fetchDirections('bike', { lng: 73.3, lat: 18.3 }, { lng: 73.4, lat: 18.4 })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n++;
      return new Response(JSON.stringify({ code: 'NoRoute' }), { status: 400 });
    });
    await expect(fetchDirections('car', { lng: 73.5, lat: 18.5 }, { lng: 73.6, lat: 18.6 })).rejects.toMatchObject({ code: 'NO_ROUTE' });
    expect(n).toBe(1);
  });

  it('formats times and distances', () => {
    expect(formatTravelTime(45)).toBe('45 s');
    expect(formatTravelTime(812.6)).toBe('14 min');
    expect(formatTravelTime(3900)).toBe('1 h 05 min');
    expect(formatTravelDistance(847)).toBe('850 m');
    expect(formatTravelDistance(5230.4)).toBe('5.2 km');
    expect(formatTravelDistance(128_400)).toBe('128 km');
  });
});
