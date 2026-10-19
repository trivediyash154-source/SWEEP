import type { CityModel } from '@sweep/engine';
import { HEIGHT_SOURCES, STOREY_HEIGHT_M } from '@sweep/engine';
import type { PickResult } from './GeoCityScene';

const fmtM = (m: number): string => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(m < 10 ? 1 : 0)} m`);

export function ringArea(city: CityModel, b: number): number {
  const a = city.bRingOff[b]!;
  const z = city.bRingOff[b + 1]!;
  let s = 0;
  for (let i = a; i < z; i++) {
    const j = i + 1 < z ? i + 1 : a;
    s += city.bRingXY[2 * i]! * city.bRingXY[2 * j + 1]! - city.bRingXY[2 * j]! * city.bRingXY[2 * i + 1]!;
  }
  return Math.abs(s) / 2;
}

export function segmentLabel(city: CityModel, s: number): string {
  const w = city.ways[city.segWay[s]!]!;
  return w.name ?? w.ref ?? `Unnamed ${w.highway.replace('_', ' ')}`;
}

function nodeStreets(city: CityModel, n: number): string[] {
  const names = new Set<string>();
  let degree = 0;
  for (let s = 0; s < city.segCount; s++) {
    if (city.segU[s] === n || city.segV[s] === n) {
      degree++;
      names.add(segmentLabel(city, s));
    }
  }
  return [`${degree} street segment${degree === 1 ? '' : 's'}`, ...[...names].slice(0, 4)];
}

const HEIGHT_TEXT: Record<string, string> = {
  height: 'From the OpenStreetMap height tag',
  levels: `From building:levels × ${STOREY_HEIGHT_M} m (storey height assumed)`,
  estimate: 'Estimated for visual context; OpenStreetMap has no height for this building',
};

export function FeatureDetails({ city, pick, compact = false }: { city: CityModel; pick: PickResult; compact?: boolean }) {
  if (pick.kind === 'segment') {
    const s = pick.seg;
    const w = city.ways[city.segWay[s]!]!;
    const rows: [string, string][] = [
      ['Class', w.highway.replace(/_/g, ' ')],
      ['Length', fmtM(city.segLen[s]!)],
      ['Direction', city.segOneway[s] ? 'One-way (mapped direction)' : 'Two-way'],
    ];
    if (w.maxspeed) rows.push(['Speed limit', `${w.maxspeed} (OSM tag)`]);
    else if (!compact) rows.push(['Speed limit', 'Not tagged in OSM']);
    const access = (['access', 'vehicle', 'motor_vehicle', 'hgv', 'bicycle', 'foot'] as const).filter((k) => w[k]).map((k) => `${k}=${w[k]}`);
    if (access.length) rows.push(['Access', access.join(', ')]);
    if (w.surface && !compact) rows.push(['Surface', w.surface]);
    if (w.lanes && !compact) rows.push(['Lanes', w.lanes]);
    return (
      <div className="feat" data-testid="feature-segment">
        <p className="feat__kind">Street segment</p>
        <h3 className="feat__title">{segmentLabel(city, s)}</h3>
        <dl className="feat__rows">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {!compact && (
          <a className="feat__osm" href={`https://www.openstreetmap.org/way/${w.id}`} target="_blank" rel="noreferrer noopener">
            OSM way {w.id} ↗
          </a>
        )}
      </div>
    );
  }
  if (pick.kind === 'node') {
    const n = pick.node;
    const [deg, ...names] = nodeStreets(city, n);
    return (
      <div className="feat" data-testid="feature-node">
        <p className="feat__kind">Intersection</p>
        <h3 className="feat__title">{names.slice(0, 2).join(' × ') || 'Junction'}</h3>
        <dl className="feat__rows">
          <div>
            <dt>Connects</dt>
            <dd>{deg}</dd>
          </div>
          <div>
            <dt>Position</dt>
            <dd className="mono">
              {city.nodeLat[n]!.toFixed(6)}°N, {city.nodeLon[n]!.toFixed(6)}°E
            </dd>
          </div>
        </dl>
        {!compact && (
          <a className="feat__osm" href={`https://www.openstreetmap.org/node/${city.nodeOsm[n]}`} target="_blank" rel="noreferrer noopener">
            OSM node {city.nodeOsm[n]} ↗
          </a>
        )}
      </div>
    );
  }
  if (pick.kind === 'building') {
    const b = pick.building;
    const src = HEIGHT_SOURCES[city.bHeightSrc[b]!]!;
    const lv = city.bLevels[b]!;
    return (
      <div className="feat" data-testid="feature-building">
        <p className="feat__kind">Building</p>
        <h3 className="feat__title">{city.bKinds[city.bKind[b]!] === 'yes' ? 'Building (type not tagged)' : city.bKinds[city.bKind[b]!]}</h3>
        <dl className="feat__rows">
          <div>
            <dt>Footprint</dt>
            <dd>{ringArea(city, b).toFixed(0)} m² (mapped)</dd>
          </div>
          <div>
            <dt>Height</dt>
            <dd>
              {city.bHeight[b]!.toFixed(1)} m{src === 'estimate' ? ' (estimate)' : ''}
            </dd>
          </div>
          <div>
            <dt>Height source</dt>
            <dd data-testid="height-source">{HEIGHT_TEXT[src]}</dd>
          </div>
          {lv > 0 && (
            <div>
              <dt>Levels</dt>
              <dd>{lv} (OSM tag)</dd>
            </div>
          )}
        </dl>
        {!compact && (
          <a className="feat__osm" href={`https://www.openstreetmap.org/way/${city.bOsm[b]}`} target="_blank" rel="noreferrer noopener">
            OSM way {city.bOsm[b]} ↗
          </a>
        )}
      </div>
    );
  }
  return null;
}
