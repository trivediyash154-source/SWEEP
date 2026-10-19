# SWEEP: Project Brief

**Every street has a story. Every route has a proof.**

SWEEP is an urban route-intelligence platform. You build, import or acquire a street network, mark which streets need service, and SWEEP computes the **exact shortest closed route** that covers them all. Undirected networks are the Chinese Postman Problem; one-way and mixed networks are the directed and mixed versions. SWEEP then shows *why* the route is optimal, one step at a time, in a 3D city and a 2D projection. For several vehicles it splits the route with an honestly stated guarantee.

## Origin

SWEEP was built as a Discrete Mathematics project (graph theory, Unit 6: Euler tours, degrees, matching, shortest paths) and designed as a credible standalone product.

## What makes it different

* **Exact, not heuristic.** Undirected routes use Edmonds' blossom matching; one-way networks use a minimum-cost flow. Both carry an LP-duality optimality certificate on every run and are cross-checked by independent oracles. Where a guarantee is weaker, as for fleets, SWEEP states exactly what it is.
* **Explainable.** A step-by-step investigation driven by the actual computation and highlighted in the city: degrees, odd vertices, shortest paths, matching, augmentation and the Euler circuit; or balance, flow and certificate for one-way networks.
* **Real data.** Live OpenStreetMap acquisition with provenance, and a bundled real Zurich extract.
* **Honest numbers.** Every figure in the interface comes from the engine. Baselines are real alternative routes (greedy pairing, out-and-back), clearly labelled.
* **Distinctive experience.** Royal velvet and porcelain themes, a cinematic procedural 3D city, a cherry-blossom cursor field, and editorial typography. It is not a generic dashboard.

## Status

Nine milestones are implemented and tested; see [TASKS.md](TASKS.md) and [TEST_PLAN.md](TEST_PLAN.md). `pnpm verify` passes locally and on GitHub Actions:

* 141 unit and integration tests;
* independent oracles over 661 undirected and 1,401 directed or mixed graphs;
* 37 browser tests.

Docker is verified (build, health, persistence, restart). Public hosting has not been set up, because it needs an account on a hosting provider; see [DEPLOYMENT.md](DEPLOYMENT.md).

## Repository map

```
packages/engine   undirected, directed/mixed and fleet solvers, validation, verification, GeoJSON, OSM, examples
apps/server       Hono API, SQLite, optional auth, worker-thread solver, map acquisition
apps/web          React app: landing, long-form workspace (3D district, projection, maths, lab, editor), report
oracle/           Python cross-checks: networkx matching and min-cost flow, brute force, state search
e2e/              Playwright end-to-end and accessibility tests
docs/screenshots  captured UI
```
