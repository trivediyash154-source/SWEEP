import type { CityModel } from '@sweep/engine';
import { Dialog } from '../components/Dialog';

export function ProvenanceDialog({ city, onClose, timings }: { city: CityModel; onClose: () => void; timings: { fetchMs: number; decodeMs: number; geometryMs: number; bytes: number } | null }) {
  const p = city.provenance;
  const s = city.stats;
  const b = s.buildings;
  return (
    <Dialog title="Data provenance" onClose={onClose} wide>
      <div className="prov" data-testid="provenance">
        <p className="muted">
          {city.description} Source: <strong>{p.source}</strong>, {p.attribution}, licensed under the{' '}
          <a href={p.licenseUrl} target="_blank" rel="noreferrer noopener">
            {p.license}
          </a>
          .
        </p>
        <dl className="prov__grid">
          <div>
            <dt>Region (S, W, N, E)</dt>
            <dd className="mono">{p.bbox.join(', ')}</dd>
          </div>
          <div>
            <dt>Area</dt>
            <dd>{s.areaKm2} km²</dd>
          </div>
          <div>
            <dt>OSM database state</dt>
            <dd className="mono">{p.osmBase[0] === p.osmBase[1] ? p.osmBase[0] : `${p.osmBase[0]} – ${p.osmBase[1]}`}</dd>
          </div>
          <div>
            <dt>Downloaded</dt>
            <dd className="mono">{p.fetched[0] === p.fetched[1] ? p.fetched[0] : `${p.fetched[0]} – ${p.fetched[1]}`}</dd>
          </div>
          <div>
            <dt>Tiles</dt>
            <dd data-testid="prov-tiles">
              {p.tiles.ok} of {p.tiles.total} downloaded{p.tiles.missing.length ? ` · ${p.tiles.missing.length} missing (area incomplete)` : ' · complete'}
            </dd>
          </div>
          <div>
            <dt>Endpoint</dt>
            <dd className="mono small">{p.endpoints.join(', ')}</dd>
          </div>
          <div>
            <dt>Street network</dt>
            <dd>
              {s.nodes.toLocaleString()} intersections · {s.segments.toLocaleString()} segments · {s.roadLengthKm} km · {s.onewaySegments} one-way
            </dd>
          </div>
          <div>
            <dt>Turn restrictions</dt>
            <dd>
              {s.restrictions.mapped} mapped · {s.restrictions.unsupported} unsupported
            </dd>
          </div>
          <div>
            <dt>Buildings</dt>
            <dd data-testid="prov-buildings">
              {b.total.toLocaleString()} footprints · heights: {b.bySource.height} tagged, {b.bySource.levels} from levels, {b.bySource.estimate.toLocaleString()} estimated
            </dd>
          </div>
          {timings && (
            <div>
              <dt>Load (this browser)</dt>
              <dd className="mono small">
                {(timings.bytes / 1024 / 1024).toFixed(2)} MB · fetch {timings.fetchMs.toFixed(0)} ms · decode {timings.decodeMs.toFixed(0)} ms · meshes {timings.geometryMs.toFixed(0)} ms
              </dd>
            </div>
          )}
        </dl>
        <h3>Estimates and assumptions</h3>
        <ul className="prov__list">
          {p.estimates.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
        <h3>Transformations</h3>
        <ul className="prov__list">
          {p.transformations.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
        <h3>Limitations</h3>
        <ul className="prov__list">
          {p.limitations.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
