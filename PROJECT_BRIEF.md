# SWEEP: Project Brief

**Every street has a story. Every route has a proof.**

SWEEP is an urban route-intelligence platform. You build or import a street network, mark which streets need service, and SWEEP computes the **exact shortest closed route** that covers them all: the undirected Chinese Postman Problem. It then shows *why* that route is optimal, one step at a time, in 2D and 3D.

## Origin

SWEEP was built as a Discrete Mathematics project (graph theory, Unit 6: Euler tours, degrees, matching, shortest paths) and designed as a credible standalone product.

## What makes it different

* **Exact, not heuristic.** Edmonds' blossom matching with an LP-duality optimality certificate on every run, cross-checked by an exhaustive DP on small cases.
* **Explainable.** A seven-step explanation driven by the actual computation: degrees, odd vertices, auxiliary complete graph, minimum matching, augmentation, Euler circuit, verification.
* **Honest numbers.** Every figure in the interface comes from the engine. Baselines are real alternative routes (greedy pairing, out-and-back), clearly labelled.
* **Distinctive experience.** Royal velvet and porcelain themes, a cinematic procedural 3D city, a cherry-blossom cursor field, and editorial typography. It is not a generic dashboard.

## Status

All six milestones are implemented and tested; see [TASKS.md](TASKS.md) and [TEST_PLAN.md](TEST_PLAN.md). `pnpm verify` passes: 57 unit and integration tests, an independent oracle over 660 graphs, and 32 browser tests. Public hosting has not been set up, because it needs an account on a hosting provider; see [DEPLOYMENT.md](DEPLOYMENT.md).

## Repository map

```
packages/engine   exact solver, validation, verification, GeoJSON, examples (pure TypeScript)
apps/server       Hono API, SQLite, auth, worker-thread solver
apps/web          React app: landing, workspace, 3D, auth, report
oracle/           Python networkx + brute-force cross-check
e2e/              Playwright end-to-end and accessibility tests
docs/screenshots  captured UI
```
