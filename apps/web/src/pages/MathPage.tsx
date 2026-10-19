import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { solveChinesePostman } from '@sweep/engine';
import { getExample } from '@sweep/engine/examples';
import { SiteNav } from '../components/SiteNav';
import { StaticNetwork } from '../landing/StaticNetwork';
import { formatDistance } from '../lib/format';
import '../styles/landing.css';
import '../styles/math.css';

export default function MathPage() {
  const trap = useMemo(() => {
    const ex = getExample('greedy-trap')!;
    const r = solveChinesePostman(ex.graph);
    return { graph: ex.graph, r: r.ok ? r : null };
  }, []);
  const greedyAdded = trap.r ? trap.r.baselines.find((b) => b.id === 'greedy-pairing')!.total! - trap.r.route.requiredDistance : 0;

  return (
    <div className="page">
      <SiteNav />
      <main id="main" className="math">
        <header className="math__head">
          <p className="eyebrow">Mathematical specification</p>
          <h1>
            The Chinese Postman Problem, <span className="serif">solved exactly and explained.</span>
          </h1>
          <p className="section__lede">This page describes exactly what SWEEP computes, why the result is optimal, how each result is checked, and where the method stops.</p>
        </header>

        <nav className="math__toc" aria-label="Contents">
          <a href="#model">1 · Model</a>
          <a href="#problem">2 · Problem</a>
          <a href="#theorem">3 · Why it works</a>
          <a href="#algorithm">4 · Algorithm</a>
          <a href="#certificate">5 · Certificates</a>
          <a href="#extensions">6 · Extensions &amp; limits</a>
        </nav>

        <section id="model" className="math__sec">
          <h2>1 · Model</h2>
          <p>
            A street network is an <strong>undirected weighted multigraph</strong> G = (V, E, w). Vertices are intersections and edges are street segments. Parallel edges (two distinct streets joining the same intersections) and self-loops (a street that returns to its own intersection; it adds 2 to the degree) are supported. Weights are finite and non-negative, so zero-length links are allowed. Internally, lengths are stored as integer milli-units, so every sum and comparison is exact.
          </p>
          <p>
            A subset R ⊆ E of <strong>required</strong> streets must be serviced. Every other street is optional: it may be driven to reposition (a "deadhead") but needs no service. The route is a <strong>closed walk</strong> that starts and ends at a chosen start vertex on a required street.
          </p>
        </section>

        <section id="problem" className="math__sec">
          <h2>2 · Problem</h2>
          <div className="formula formula--block">minimise  w(W)  over closed walks W in G  such that every e ∈ R appears in W at least once</div>
          <p>
            When R = E this is the classical <em>Chinese Postman Problem</em>, studied by Meigu Guan in 1960. It differs from the Euler-circuit question: an Euler circuit uses each edge <em>exactly</em> once and exists only if every degree is even. The postman may repeat streets, and repetition is often unavoidable.
          </p>
        </section>

        <section id="theorem" className="math__sec">
          <h2>3 · Why the method is optimal</h2>
          <ol className="math__list">
            <li>
              <strong>Parity.</strong> In any closed walk, every vertex is entered and left equally often. So the multiset of traversed edges has even degree everywhere (Euler 1736; Hierholzer 1873 showed this suffices in connected graphs).
            </li>
            <li>
              <strong>Odd vertices.</strong> Let T be the set of vertices with odd degree in the required subgraph (V, R). Since Σ deg(v) = 2|R|, the size of T is even.
            </li>
            <li>
              <strong>T-joins.</strong> The extra traversals X must turn every vertex of T even and leave the others even, so X is a <em>T-join</em>. The optimal cost is w(R) + min w(X) over T-joins, provided R ∪ X is connected. This holds automatically when R is connected (Edmonds &amp; Johnson, 1973).
            </li>
            <li>
              <strong>Matching.</strong> A minimum-cost T-join equals the union of shortest paths of a <em>minimum-weight perfect matching</em> on T, where each pair costs its shortest-path distance in G. Optional streets may appear on those paths.
            </li>
            <li>
              <strong>Euler.</strong> After duplicating the matched paths, every degree is even and the multigraph is connected, so Hierholzer's algorithm produces a closed walk that uses each copy once. That walk is the optimal route.
            </li>
          </ol>
          {trap.r && (
            <div className="math__figure">
              <StaticNetwork graph={trap.graph} result={trap.r} overlay="route" showWeights showLabels label="Crescent Quay: exact matching versus greedy pairing" />
              <p className="small muted">
                Why matching must be exact. On Crescent Quay the two closest odd intersections are b and c (30 m apart). Pairing them first forces a and d to pair across the whole quay, so greedy pairing adds {formatDistance(greedyAdded)}. The exact minimum matching pairs each dead end with its neighbour and adds {formatDistance(trap.r.augmentation.addedDistance)}.
              </p>
            </div>
          )}
        </section>

        <section id="algorithm" className="math__sec">
          <h2>4 · Algorithm and complexity</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Step</th>
                <th>Method</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Validate</td>
                <td>Ids, endpoints, weights, connectivity of R (union–find)</td>
                <td className="mono">O(|V| + |E| α)</td>
              </tr>
              <tr>
                <td>Degrees</td>
                <td>Degree in (V, R); collect odd set T, k = |T|</td>
                <td className="mono">O(|V| + |E|)</td>
              </tr>
              <tr>
                <td>Shortest paths</td>
                <td>Dijkstra with a binary heap from each t ∈ T, over all edges</td>
                <td className="mono">O(k (|E| + |V|) log |V|)</td>
              </tr>
              <tr>
                <td>Matching</td>
                <td>Edmonds' blossom (primal–dual) on the complete graph K_T</td>
                <td className="mono">O(k³)</td>
              </tr>
              <tr>
                <td>Augment</td>
                <td>Duplicate each matched shortest path</td>
                <td className="mono">O(k |V|)</td>
              </tr>
              <tr>
                <td>Euler circuit</td>
                <td>Hierholzer, iterative</td>
                <td className="mono">O(|E| + added)</td>
              </tr>
              <tr>
                <td>Verify</td>
                <td>Independent re-check of the route</td>
                <td className="mono">O(steps)</td>
              </tr>
            </tbody>
          </table>
          <p className="small muted">The matching dominates for large networks. Interactive solving is limited to 600 odd intersections; the project's benchmarks list measured times by network size.</p>
        </section>

        <section id="certificate" className="math__sec">
          <h2>5 · Certificates and checks</h2>
          <ul className="math__list">
            <li>
              <strong>LP-duality certificate.</strong> The blossom algorithm maintains dual variables. On completion SWEEP checks dual feasibility (no edge has negative slack), complementary slackness (matched edges are tight) and the blossom conditions. Together these prove that no cheaper pairing exists.
            </li>
            <li>
              <strong>Independent cross-check.</strong> For k ≤ 16 an exhaustive subset dynamic program, O(2^k k), recomputes the minimum matching and counts how many pairings tie for the optimum.
            </li>
            <li>
              <strong>Route verifier.</strong> Every result is re-checked from the raw graph alone. Each step must traverse a real street from the previous step's endpoint; the walk must close; every required street must appear; distances must sum exactly; and service, repeat and deadhead labels must be consistent.
            </li>
            <li>
              <strong>Test suite.</strong> The solver is compared with brute-force search over all edge-duplication sets on random multigraphs, including loops, parallel edges and zero weights. A separate Python program cross-checks it with networkx's matching.
            </li>
          </ul>
        </section>

        <section id="extensions" className="math__sec">
          <h2>6 · Extensions and limits</h2>
          <ul className="math__list">
            <li>
              <strong>Disconnected required streets.</strong> If R falls into several components, the problem becomes the <em>Rural Postman Problem</em>, which is NP-hard. SWEEP refuses rather than guess, and it suggests connecting streets: a minimum spanning tree over shortest paths between components. After you accept them, the route is optimal for the enlarged set of required streets. The choice of connectors itself is a heuristic.
            </li>
            <li>
              <strong>Directed or mixed networks</strong> (one-way streets) need different algorithms (minimum-cost flow for the directed case; the mixed case is NP-hard). They are rejected with an explanation.
            </li>
            <li>
              <strong>Not modelled:</strong> multiple vehicles, capacities, time windows, turn penalties and traffic.
            </li>
            <li>
              <strong>GeoJSON import:</strong> LineStrings are split where they share a coordinate, and lengths are geodesic (haversine). Intersections that are not shared vertices in the source data will not be detected.
            </li>
          </ul>
          <p>
            <Link to="/lab?example=greedy-trap" className="btn btn--primary">
              Try Crescent Quay in the workspace
            </Link>
          </p>
        </section>
      </main>
    </div>
  );
}
