# SWEEP

**Every street. One intelligent route.**
*Every street has a story. Every route has a proof.*

SWEEP is an urban route-intelligence platform. You build, import or acquire a street network and mark the streets that need service. SWEEP then computes the **shortest closed route that covers them all**, proves that it is optimal, and drives it through a 3D city:

* undirected networks: the Chinese Postman Problem;
* one-way and mixed networks: the directed and mixed postman problems;
* several vehicles: a split route with a stated guarantee.

No account is needed for any of it.

## Real maps: Directions (`/directions`) and Sweep planner (`/sweep`)

Both pages use a full map of the world (OpenFreeMap vector tiles, free and without a key; data © OpenStreetMap contributors).

* **Directions.**
  * Search any place (Photon type-ahead, Nominatim fallback, or typed coordinates), or click and drag points on the map.
  * Car, bicycle or walking, with alternatives, turn-by-turn instructions and a shareable link.
  * The routes come from the public OSRM servers (FOSSGIS, then the Project OSRM demo server for cars), and the page names the server next to every result.
  * They are **not** SWEEP's own engine. SWEEP's exact algorithms run in the Pune lab and the Sweep planner.
* **Sweep planner.**
  * Draw a rectangle or outline over **any real streets**, up to 25 km² (about 5 × 5 km).
  * The streets are downloaded live from OpenStreetMap: one request up to 4 km², or polite tiles of at most 3.5 km² fetched one after another and merged.
  * A street is required when its midpoint lies in the zone.
  * SWEEP's exact coverage engine then plans the routes: min-cost flow when one-way streets are obeyed; exact matching, or a bounded heuristic, when they are ignored.
  * Several vehicles and shift limits use the fleet planner, and the turns are reordered.
  * Every result shows the proven lower bound, the gap, an honest method label and the independent checks, and exports GPX and CSV.

## City workspace: real Pune (`/workspace`)

The city workspace runs on real OpenStreetMap data for Pune, Bibwewadi and the VIT area (about 4 × 4 km). The bundled extract is **partial**: it was built from 59 of the 85 tile downloads, and the app lists the missing tiles in its provenance dialog.

| Item | Count |
|---|---|
| Intersections | 4,753 |
| Street segments | 5,691 (327.4 km; 583 one-way) |
| Building footprints | 12,404 |

Building heights come from the OSM `height` tag or `building:levels` for a handful of buildings; all others are estimates. Estimates are flagged as such, and the camera toolbar can tint them.

* **Route lab: who reaches first, and why.**
  * Five algorithms answer the same turn-aware query on the same graph with the same cost: Dijkstra, A*, bidirectional Dijkstra, ALT and contraction hierarchies.
  * Profiles: car, truck, bicycle and walking.
  * Every route is checked by an independent validator.
  * Replay shows each algorithm's real settle order.
  * Reachability bands show what can be reached in 5, 10 and 15 minutes.
  * A printable report with the algorithm table, the independent checks, the profile assumptions and a street-by-street route sheet whose turns match the engine's turn model.
* **Coverage & fleet.**
  * Draw a service zone (rectangle, circle or free outline) and place a depot (and optionally a disposal site), then plan routes that cover every street in the zone.
  * Methods:
    * respecting one-way streets: exact directed min-cost flow;
    * ignoring them: exact undirected matching, or for large zones a heuristic reported with a valid lower bound and gap.
  * Multi-vehicle plans with shift and capacity limits, with their lower bounds. When the limits need more vehicles than you have, the plan says how many routes it needs instead of claiming a result.
  * Several depots in one plan, each with its own vehicles: streets go to the depot with the cheapest round trip, and the lower bounds hold for any split between depots.
  * Main roads within a deadline (optional): trunk to tertiary roads must be serviced within a set time of the shift start, for example before the morning traffic. The plan shows when each vehicle finishes them, and lower bounds on that finish time and on the vehicles needed. When those bounds prove the deadline impossible, the plan says so.
  * Turn-aware order (on by default): the same street traversals and the same distance, reordered to avoid U-turns and right turns (traffic keeps left). The plan reports the turn counts, the turn-penalty time and a lower bound on it.
  * A deterministic shift timeline.
  * Cost and CO₂ estimates from your own assumptions, applied to the distance and hours the vehicles actually drive.
  * A printable report, GPX tracks (one per vehicle, for navigation devices) and a step list (CSV) with street names, OSM ids and times of day.
* **Scenarios.**
  * Close a road or change its direction on the map, then recompute routes and coverage against the unchanged baseline.
  * Change the operation for coverage: another depot, fleet size, shift limit, fuel price or wage. "Compare with baseline" plans both and shows the change in distance, hours, vehicles, fuel, CO₂ and cost.

The original abstract-network laboratory (editor, proofs, Zurich sample) is at `/lab`. To refresh the Pune data, run `pnpm city:acquire pune-bibwewadi` (resumable and polite to the public Overpass servers), then `pnpm city:build pune-bibwewadi`. See `HANDOFF.md` and `IMPLEMENTATION_STATUS.md` for the current state.

| Velvet theme | Porcelain theme (same camera) |
|---|---|
| ![City workspace, Velvet theme, focused on VIT Bibwewadi](docs/screenshots/city-velvet.png) | ![City workspace, Porcelain theme, same camera](docs/screenshots/city-porcelain.png) |

| Route lab: five algorithms on one real query | Coverage & fleet: three vehicles on a circle zone, mid-shift |
|---|---|
| ![Route lab with the computed route](docs/screenshots/city-route-velvet.png) | ![Coverage plan with three vehicle routes and the shift timeline](docs/screenshots/city-coverage-porcelain.png) |

Network lab (`/lab`):

![Network lab, Velvet theme: the 3D district with the spectral route and the vehicle](docs/screenshots/workspace-velvet.png)

| Real OSM data, directed (Porcelain) | Mathematical investigation |
|---|---|
| ![Zurich](docs/screenshots/workspace-zurich-porcelain.png) | ![Mathematics](docs/screenshots/workspace-math.png) |

| Route-performance laboratory | Fleet of three vehicles | Phone |
|---|---|---|
| ![Laboratory](docs/screenshots/workspace-lab.png) | ![Fleet](docs/screenshots/workspace-fleet.png) | ![Mobile](docs/screenshots/mobile-workspace.png) |

## What it does

* **Exact undirected optimisation.**
  * Odd-degree vertices and Dijkstra shortest paths.
  * Edmonds' blossom minimum-weight perfect matching, with an LP-duality optimality certificate on every run.
  * Path duplication and a Hierholzer Euler circuit.
  * Optional streets can be used as unserviced shortcuts (deadheading).
* **Exact directed and mixed optimisation** (a separate module; the undirected algorithm is never used for a one-way network).
  * Minimum-cost flow that balances in- and out-degrees, certified by LP duality.
  * Directed Hierholzer circuit.
  * Two service rules for two-way streets: *each direction* (both kerbs) or *either direction*. The mixed rule is solved exactly by enumerating orientations, up to 12 two-way required streets.
  * Infeasible one-way layouts are diagnosed street by street, with a one-click fix.
* **Multiple vehicles.**
  * Min–max split of the certified route (Frederickson–Hecht–Kim), with an exact split DP and the lower bound.
  * The guarantee is stated honestly: ≤ (2 − 1/k) × optimum for undirected fleets, exact for the *total distance* objective, and heuristic with no ratio claim for directed fleets.
* **Real map data.**
  * Live acquisition of an OpenStreetMap area through the Overpass API, with provider fallback, a 7-day cache, provenance and classified errors.
  * Place search through Nominatim, at most 1 request per second.
  * GeoJSON import.
  * A bundled real extract of Zurich's Altstadt (ODbL, © OpenStreetMap contributors).
* **The workspace** is one long, scrollable environment:
  * **A** command header;
  * **B** a dominant 3D district simulation:
    * buildings aligned to the real streets;
    * a spectral route shader driven by true route distance;
    * vehicles that follow the computed order;
    * orbit, focus and follow cameras;
  * **C** a live 2D projection;
  * **D** a step-by-step mathematical investigation generated from the actual computation and highlighted in the city;
  * **E** a laboratory comparing the exact route with real baselines, the undirected relaxation and fleet sizes;
  * **F** a network editor: add, move, connect, weights, required, one-way, delete, undo and redo, auto-solve;
  * **G** verification and the technical report;
  * **H** local scenario and experiment history;
  * **I** exports (JSON, route/streets/fleet CSV, GeoJSON, printable report).
* **Honest results.**
  * Independent verification checks on every run.
  * Real baselines (lower bound, greedy pairing or balancing, out-and-back or return-after-each).
  * Assumptions and a reproducibility hash.
  * "Clear local data" removes everything SWEEP stored in the browser, after confirmation.
* **Two themes.** *Velvet*, a royal aubergine night with champagne-gold hairlines, and *Porcelain*, a cream architectural model. Both come with a cherry-blossom cursor field: lighter over the editor, never in the way of controls, and off under reduced motion.
* **Optional accounts.** scrypt-hashed passwords, hashed session tokens, CSRF protection and rate limits, plus owner-scoped scenarios and stored runs. Nothing requires signing in.

## Quick start

```bash
corepack enable
pnpm install
pnpm build
pnpm start          # → http://localhost:8787 (API + web app)
```

* **Development:** `pnpm dev` runs the web app on :5173 and the API on :8787.
* **Docker:** `docker compose up --build`. See [DEPLOYMENT.md](DEPLOYMENT.md) for the image, the health check, persistence and the `tests` profile.
* **Static build:** `pnpm build:static` produces a serverless build in `apps/web/dist-static/` that runs the identical engine in Web Workers. It uses hash routes (the city workspace is at `/#/workspace`). Accounts and the server's map-acquisition cache are not available in it; map acquisition then goes straight from the browser to Overpass.

The workspace opens straight into a solved district. Bundled examples work offline. Live map acquisition needs outbound access to a public Overpass instance; when none is reachable, SWEEP says which providers failed and why, and points to GeoJSON import or the bundled Zurich sample.

## Tests

```bash
pnpm verify    # typecheck → lint → unit/property/integration → Python oracle → build → Playwright e2e + axe
```

Latest recorded run (2026-10-20, 59-tile Pune bundle): **all green**, locally and on GitHub Actions (the `verify` job, plus a `docker` job that builds the image, checks health, smoke-tests and restarts).

| Suite | Count |
|---|---|
| Engine | 178 tests |
| Server | 38 tests |
| Web | 50 tests |
| Oracle, undirected | 661 graphs, checked against networkx and brute force |
| Oracle, directed and mixed | 1,401 graphs, checked against networkx min-cost flow and a state-space search |
| Browser | 73 end-to-end and accessibility tests, desktop and mobile, both themes, including 19 on the real Pune data checked against independent engine runs, and the Directions and Sweep planner pages |

Details are in [TEST_PLAN.md](TEST_PLAN.md).

## Documentation

| Document | Contents |
|---|---|
| [PROJECT_BRIEF.md](PROJECT_BRIEF.md) | What and why |
| [PRD.md](PRD.md) | Requirements and their status |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Components, API, data model, frontend structure |
| [MATHEMATICAL_SPEC.md](MATHEMATICAL_SPEC.md) | Model semantics, algorithms, proofs, guarantees, complexity |
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | Themes, tokens, typography, spectral shader, blossom field |
| [SECURITY.md](SECURITY.md) | Threat model and controls, including map acquisition |
| [TEST_PLAN.md](TEST_PLAN.md) | Test suites, latest results, performance |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Running, configuration, Docker, CI, what is and is not verified |
| [TASKS.md](TASKS.md) | Milestones and remaining work |

## Map data attribution

Street data acquired or bundled from OpenStreetMap is © OpenStreetMap contributors, available under the [Open Database License](https://www.openstreetmap.org/copyright). SWEEP shows this attribution wherever such data appears: the simulation, reports and exports.

## Limitations

* **Mixed networks.** The *either direction* rule is exact only up to 12 required two-way streets; larger instances are refused with an explanation rather than approximated.
* **Disconnected required streets.** These make the rural postman problem NP-hard. The lab refuses them, explains why and suggests connectors. The city workspace joins them with shortest connector paths and reports the result with a lower bound and gap, never as optimal.
* **Fleets.** In the lab, fleet plans split one certified route and come with the stated bound; there are no capacities or time windows. In the city workspace, fleet plans handle capacity, a shift limit and a disposal site; they are heuristics reported with valid lower bounds and gaps, not proven optima. Coverage plans order their streets to reduce turn penalties, but they do not choose extra streets to avoid turns. The only time window is the main-roads deadline (latest finish, one depot); earliest-start windows are not modelled.
* **Size.** Exact undirected matching is limited to 600 odd intersections in interactive use, and a map acquisition to 4 km².
* **3D context.** In the lab (`/lab`), buildings are procedural context generated from the streets. In the city workspace (`/workspace`) they are real OSM footprints, but most heights are flagged estimates.
* **Pune extract.** The bundled Pune data is partial: 59 of 85 tile downloads, because the public Overpass mirrors often time out and some environments block them. The region-wide turn-restriction query is among the missing downloads, so no turn restrictions are applied yet; when present, only via-node restrictions are supported.
* **Accounts.** There is no password reset, because no email service is configured.
* **Real-map pages.** They need the public services named above, which can be busy, rate-limited or blocked by a network. Each page says which service failed rather than showing a made-up result. Live downloads are capped at 25 km² to stay within the Overpass usage policy. Fleet plans on very large zones may be refused by the fleet planner; one vehicle always works.
* **Hosting.** The static build of this version runs at https://sweep-ashy.vercel.app (also https://trivediyash154-source.github.io/SWEEP/); Directions is at `/#/directions`, the Sweep planner at `/#/sweep` and the city workspace at `/#/workspace`. Everything there runs in the browser. Accounts, server-side saving and live map acquisition need the Node server. See [DEPLOYMENT.md](DEPLOYMENT.md).
