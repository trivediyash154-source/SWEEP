# SWEEP: Product Requirements (as implemented)

## Problem

Street cleaning, inspection and maintenance crews must cover every segment of a district and return to the depot. Some backtracking is unavoidable wherever intersections have an odd number of streets. Planners rarely know the minimum, which streets must be repeated, or why. Existing tools either hide the optimisation or are generic routing suites.

## Users

* **Municipal and contractor route planners.** They need a defensible minimum-distance route and an explanation they can present.
* **Students and educators in graph theory and operations research.** They need to see the Chinese Postman algorithm step by step on real computations.
* **Analysts** who import street data (GeoJSON) to estimate unavoidable repeated distance.

## Goals

1. Compute the **exact** optimal closed route for undirected networks whose required streets are connected.
2. Make the mathematics visible: odd vertices, shortest paths, matching, augmentation and the Euler circuit.
3. Show every number with its basis: real baselines, verification checks, and reproducibility metadata.
4. Work immediately with no accounts, keys or downloads; offer accounts for persistence.

## Functional requirements and status

| Area | Requirement | Status |
|---|---|---|
| Model | Vertices, weighted undirected edges, required flags, names, polylines; parallel edges, loops, zero weights | ✅ |
| Validation | Structural and semantic diagnostics with codes; directed edges rejected; limits | ✅ |
| Optimisation | Exact CPP and rural-postman extension with a connected required set; certificate; cross-check | ✅ |
| Disconnected required streets | Explained rejection; connector suggestion; one-click apply | ✅ |
| Editor | Add, move, rename and delete vertices; connect, delete, rename and re-weight edges; toggle required; set start; undo and redo; pan and zoom; keyboard table editor | ✅ |
| Examples | 10 bundled deterministic networks, covering all the cases the brief asks for | ✅ |
| Results | Totals, repeated distance, baselines, checks, assumptions, engine metadata | ✅ |
| Explain | 7 steps generated from the actual record, with play, pause, next, previous, restart and speed | ✅ |
| Route animation | 2D and 3D vehicle along the actual ordered route, with playback controls and a readout | ✅ |
| 3D | Procedural city from the graph data, repeated segments coded by colour, WebGL fallback | ✅ |
| Landing | Cinematic hero, botanical cursor and bloom, scroll narrative with live engine figures | ✅ |
| Accounts | Register, sign in, sign out, account settings, password change, deletion, session expiry | ✅ |
| Password reset | Needs an email service | ❌ Not available; documented |
| Scenarios | Create, rename, duplicate, delete, reopen; stored reproducible runs; run history | ✅ |
| Local mode | Full use without an account; scenarios saved in the browser | ✅ |
| Import | SWEEP JSON; GeoJSON LineString and MultiLineString with preview and limits | ✅ |
| Live OpenStreetMap retrieval | Optional | ❌ Not implemented (Overpass is blocked in the build environment); import exported GeoJSON instead |
| Export | JSON (graph and result), route CSV, streets CSV, printable report (print to PDF) | ✅ |
| Themes | Velvet (royal dark) and Porcelain (cream) | ✅ |

## Non-functional requirements

* **Correctness:** independent verification on every run; exhaustive and networkx cross-checks in tests.
* **Performance:** interactive solving up to 600 odd intersections (benchmarked); bounded particle system; lazy-loaded 3D.
* **Security:** see SECURITY.md.
* **Accessibility:** WCAG AA contrast, keyboard paths, reduced motion, axe checks.
* **Reproducibility:** deterministic engine; stored runs keep the graph snapshot, configuration, version and hash.

## Out of scope (this version)

One-way or mixed networks, multiple vehicles, capacities, time windows, turn penalties, live traffic, and email flows.
