# SWEEP: Product Requirements (as implemented)

## Problem

Street cleaning, inspection and maintenance crews must cover every segment of a district and return to the depot. Some backtracking is unavoidable wherever intersections have an odd number of streets. Planners rarely know the minimum, which streets must be repeated, or why. Existing tools either hide the optimisation or are generic routing suites.

## Users

* **Municipal and contractor route planners.** They need a defensible minimum-distance route and an explanation they can present.
* **Students and educators in graph theory and operations research.** They need to see the Chinese Postman algorithm step by step on real computations.
* **Analysts** who import street data (GeoJSON) or acquire an OpenStreetMap area to estimate unavoidable repeated distance, one-way effects and fleet sizes.

## Goals

1. Compute the **exact** optimal closed route for undirected, directed and (small) mixed networks whose required streets are connected. For fleets, report a split with an honest, stated guarantee.
2. Make the mathematics visible: odd vertices, shortest paths, matching, augmentation and the Euler circuit.
3. Show every number with its basis: real baselines, verification checks, and reproducibility metadata.
4. Work immediately with no accounts, keys or downloads; offer accounts for persistence.

## Functional requirements and status

| Area | Requirement | Status |
|---|---|---|
| Model | Vertices, weighted undirected edges, required flags, names, polylines; parallel edges, loops, zero weights | ✅ |
| Validation | Structural and semantic diagnostics with codes; one-way policy (refuse, explicit relaxation, directed); limits | ✅ |
| Optimisation | Exact CPP and rural-postman extension with a connected required set; certificate; cross-check | ✅ |
| One-way streets | Directed CPP by minimum-cost flow (LP certificate), mixed CPP exact up to 12 two-way required streets, feasibility diagnosis and fix; never solved by the undirected algorithm | ✅ |
| Multiple vehicles | Min–max split with lower bound and stated guarantee; route-length limits; per-vehicle verification, animation and export | ✅ (not a proven min–max optimum; labelled) |
| Disconnected required streets | Explained rejection; connector suggestion; one-click apply | ✅ |
| Editor | Add, move, rename and delete vertices; connect, delete, rename and re-weight edges; toggle required; set start; undo and redo; pan and zoom; keyboard table editor | ✅ |
| Examples | 10 bundled deterministic networks, covering all the cases the brief asks for | ✅ |
| Results | Totals, repeated distance, baselines, checks, assumptions, engine metadata | ✅ |
| Mathematical investigation | Steps generated from the actual record (undirected: degrees → matching → Euler; directed: balance → flow → certificate), highlighted in the city and the projection | ✅ |
| Route animation | Vehicles along the actual ordered route(s) by true distance, with play, pause, speed, scrubbing, follow camera and a readout | ✅ |
| 3D | Dominant district simulation from the graph data: streets, junctions, one-way arrows, buildings as context, spectral route shader, camera tools; WebGL fallback to the 2D projection | ✅ |
| Laboratory | Exact vs baselines, required vs total, directed vs relaxation, fleet-size sweep | ✅ |
| Landing | Cinematic hero, botanical cursor and bloom, scroll narrative with live engine figures | ✅ |
| Accounts | Register, sign in, sign out, account settings, password change, deletion, session expiry | ✅ |
| Password reset | Needs an email service | ❌ Not available; documented |
| Scenarios | Create, rename, duplicate, delete, reopen; stored reproducible runs; run history | ✅ |
| Local mode | Full use without an account; scenarios saved in the browser | ✅ |
| Import | SWEEP JSON; GeoJSON LineString and MultiLineString with preview and limits | ✅ |
| Live OpenStreetMap retrieval | Overpass acquisition with provider fallback, cache, provenance and classified errors; place search | ✅ (needs outbound access to a public Overpass instance) |
| Real sample data | Bundled Zurich Altstadt extract (ODbL, unedited) | ✅ |
| Export | JSON (graph, settings, result, fleet), route CSV, streets CSV, fleet CSV, GeoJSON, printable report (print to PDF) | ✅ |
| Local data | Scenario and experiment history in the browser; "Clear local data" with confirmation | ✅ |
| Themes | Velvet (royal dark) and Porcelain (cream) | ✅ |

## Non-functional requirements

* **Correctness:** independent verification on every run; exhaustive and networkx cross-checks in tests.
* **Performance:** interactive solving up to 600 odd intersections (benchmarked); bounded particle system; lazy-loaded 3D.
* **Security:** see SECURITY.md.
* **Accessibility:** WCAG AA contrast, keyboard paths, reduced motion, axe checks.
* **Reproducibility:** deterministic engine; stored runs keep the graph snapshot, configuration, version and hash.

## Out of scope (this version)

Large mixed networks (more than 12 required two-way streets under the *either* rule), exact min–max fleet optimisation, capacities, time windows, turn penalties, live traffic, and email flows.
