# Bundled real map data

This directory holds the only **real** (not synthetic) street data shipped with SWEEP.
Every other example in `../index.ts` is synthetic.

## `zurichAltstadt.ts` — Zurich Altstadt / Niederdorf, Switzerland

| | |
|---|---|
| Source | OpenStreetMap, via the Overpass API |
| Endpoint | `https://overpass.osm.ch/api/interpreter` (Swiss Overpass instance, covers Switzerland only) |
| Retrieved | 2026-10-18, about 23:23 UTC |
| Bounding box | south 47.3700, west 8.5400, north 47.3735, east 8.5455 (WGS84 degrees), about 0.16 km² |
| Response | 144 ways, 831 nodes (125 KB raw JSON; `generator: Overpass API 0.7.62.4 2390de5a`) |
| Licence | Open Database License (ODbL) 1.0 |
| Attribution | © OpenStreetMap contributors |

Query (Overpass QL), exactly as sent:

```
[out:json][timeout:25];way["highway"~"^(residential|tertiary|secondary|primary|unclassified|living_street|service|pedestrian)$"](47.3700,8.5400,47.3735,8.5455);(._;>;);out body;
```

### What was changed

- **Kept exactly:** every element, every id, every latitude/longitude, every way's node list,
  and the response's `version`, `generator` and `osm3s` fields.
- **Trimmed:** node tags were dropped; way tags were reduced to the ones SWEEP's converter
  reads (`highway`, `name`, `ref`, `oneway`, `junction`, `area`, `service`, `access`).
- **Nothing was added, invented or edited.** No segment, node or coordinate was created
  or moved by hand.

The TypeScript module was generated mechanically from the raw response. To refresh it, run
the query above against any Overpass API instance (respecting its usage policy), and
regenerate the module from the new JSON with the same trimming. Then update the retrieval
time here, in the module header, and in the example's `source.retrievedAt`.

### How SWEEP uses it

`../index.ts` registers the example `zurich-altstadt` ("Zurich Altstadt (real OSM data)").
It is converted at load time with `osmToGraph` (`../../osm.ts`), with provenance kind
`bundled-sample`. The converter's rules (intersection detection, one-way handling, removal of
duplicate and zero-length segments, choice of the largest connected network) are documented
at the top of `osm.ts`. The conversion notes are stored in `graph.source.notes`.

The area is mostly pedestrian lanes (`highway=pedestrian`) with a few residential and
service streets. Several streets are one-way (`oneway=yes`), for example Limmatquai and
Rennweg. A box cut through a real city leaves some one-way streets leading out of the area.
The converter reports these, because a directed closed route cannot cover them without
leaving the box. At load time the example marks exactly those segments **optional**
(`findUnserviceableStreets` from the depot; 32 segments in this extract): they stay in the
network and can still be driven, but are no longer service obligations, so the directed
problem is well posed. This is recorded in `graph.source.notes`; no street is removed or
invented.

## Licence and attribution requirements

OpenStreetMap data is © OpenStreetMap contributors and available under the
[Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/)
(see <https://www.openstreetmap.org/copyright>). Anywhere this data, or a network or
route derived from it, is displayed or exported, SWEEP must show:

> © OpenStreetMap contributors (ODbL 1.0)

If you distribute a modified database derived from it, the ODbL share-alike terms apply
to that database.
