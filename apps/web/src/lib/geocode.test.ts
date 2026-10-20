import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseLatLng, parsePhoton, suggestPlaces } from './geocode';

afterEach(() => vi.unstubAllGlobals());

// A response in Photon's GeoJSON format (test double).
const photon = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [73.8553, 18.5195] }, properties: { osm_type: 'W', osm_id: 1, osm_key: 'historic', osm_value: 'castle', name: 'Shaniwar Wada', district: 'Shaniwar Peth', city: 'Pune', state: 'Maharashtra', country: 'India' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [73.8553, 18.5195] }, properties: { osm_type: 'N', osm_id: 2, name: 'Shaniwar Wada', city: 'Pune' } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [73.87, 18.46] }, properties: { osm_type: 'N', osm_id: 3, housenumber: '666', street: 'Upper Indiranagar', city: 'Pune' } },
    { type: 'Feature', geometry: { type: 'Point' }, properties: { name: 'No coordinates' } },
  ],
};

describe('place search', () => {
  it('parses typed coordinates (lat, lng)', () => {
    expect(parseLatLng('18.5204, 73.8567')).toEqual({ lat: 18.5204, lng: 73.8567 });
    expect(parseLatLng('18.5204 73.8567')).toEqual({ lat: 18.5204, lng: 73.8567 });
    expect(parseLatLng('Pune')).toBeNull();
    expect(parseLatLng('118.5, 73.8')).toBeNull();
  });

  it('turns Photon features into places, deduplicated, with readable second lines', () => {
    const places = parsePhoton(photon);
    expect(places).toHaveLength(2);
    expect(places[0]).toMatchObject({ label: 'Shaniwar Wada', detail: 'Shaniwar Peth, Pune, Maharashtra, India', lng: 73.8553, lat: 18.5195, kind: 'historic:castle' });
    expect(places[1]).toMatchObject({ label: '666 Upper Indiranagar', detail: 'Pune' });
  });

  it('asks Photon near the map view, and answers coordinates without any request', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (u: URL) => {
      urls.push(String(u));
      return new Response(JSON.stringify(photon), { status: 200 });
    });
    const res = await suggestPlaces('shaniwar', { lng: 73.85, lat: 18.52 });
    expect(res[0]!.label).toBe('Shaniwar Wada');
    expect(urls[0]).toContain('https://photon.komoot.io/api/?q=shaniwar');
    expect(urls[0]).toContain('lat=18.5200');
    const c = await suggestPlaces('18.46, 73.87', null);
    expect(c[0]).toMatchObject({ source: 'coordinates', lat: 18.46, lng: 73.87 });
    expect(urls).toHaveLength(1);
  });
});
