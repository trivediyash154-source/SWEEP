/**
 * Bridge used by the Python oracle: reads {"graphs": Graph[], "directed": {graph, twoWay}[]}
 * from stdin and writes the SWEEP engine's answers to stdout as JSON.
 *
 * Undirected graphs go to the undirected solver. Bundled examples with one-way
 * streets are sent twice: to the directed solver (their real model) and to the
 * undirected solver with the one-way restrictions explicitly ignored (the
 * relaxation the UI offers), which networkx can check as an undirected problem.
 */
import { solveChinesePostman, solveDirectedPostman, verifyRoute, verifyDirectedRoute, type Graph, type TwoWayService } from '../packages/engine/src/index.js';
import { EXAMPLES } from '../packages/engine/src/examples/index.js';

const chunks: Buffer[] = [];
process.stdin.on('data', (c: Buffer) => chunks.push(c));
process.stdin.on('end', () => {
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    graphs: Graph[];
    directed?: { graph: Graph; twoWay: TwoWayService }[];
    includeExamples?: boolean;
  };
  const graphs: { g: Graph; name: string; ignoreOneway: boolean }[] = input.graphs.map((g, i) => ({ g, name: `random-${i}`, ignoreOneway: false }));
  const directed: { g: Graph; name: string; twoWay: TwoWayService }[] = (input.directed ?? []).map((d, i) => ({ g: d.graph, name: `directed-${i}`, twoWay: d.twoWay }));
  if (input.includeExamples) {
    for (const ex of EXAMPLES) {
      const oneway = ex.graph.edges.some((e) => e.oneway === true || e.directed === true);
      if (!oneway) {
        graphs.push({ g: ex.graph, name: `example:${ex.id}`, ignoreOneway: false });
        continue;
      }
      graphs.push({ g: ex.graph, name: `example:${ex.id} (one-way ignored: undirected relaxation)`, ignoreOneway: true });
      directed.push({ g: ex.graph, name: `example:${ex.id} (directed)`, twoWay: ex.graph.routing?.twoWay ?? 'both' });
    }
  }
  const results = graphs.map(({ g, name, ignoreOneway }) => {
    const example = name.startsWith('example:');
    const r = solveChinesePostman(g, { limits: { maxOddVertices: 2000 }, ignoreOneway });
    if (!r.ok) return { name, graph: example ? g : undefined, ok: false, codes: r.validation.issues.filter((x) => x.severity === 'error').map((x) => x.code) };
    const v = verifyRoute(g, r.route.steps, { depotId: r.input.depotId, expectedTotal: r.route.totalDistance });
    return {
      name,
      graph: example ? g : undefined,
      ok: true,
      total: r.route.totalDistance,
      required: r.route.requiredDistance,
      odd: r.oddVertexIds.length,
      // The relaxation deliberately drives one-way streets the wrong way; that check is reported, not hidden.
      checksPassed: r.checks.every((c) => c.passed || (ignoreOneway && c.id === 'direction')) && v.ok,
      steps: r.route.steps.map((s) => [s.edgeId, s.from, s.to]),
      depot: r.input.depotId,
    };
  });
  const directedResults = directed.map(({ g, name, twoWay }) => {
    const example = name.startsWith('example:');
    const r = solveDirectedPostman(g, { twoWay, crossCheckMaxObligations: 0 });
    if (!r.ok) return { name, twoWay, graph: example ? g : undefined, ok: false, codes: r.validation.issues.filter((x) => x.severity === 'error').map((x) => x.code) };
    const v = verifyDirectedRoute(g, r.route.steps, { depotId: r.input.depotId, twoWay, expectedTotal: r.route.totalDistance });
    return {
      name,
      twoWay,
      graph: example ? g : undefined,
      ok: true,
      total: r.route.totalDistance,
      checksPassed: r.checks.every((c) => c.passed) && v.ok,
      steps: r.route.steps.map((s) => [s.edgeId, s.from, s.to]),
      depot: r.input.depotId,
    };
  });
  process.stdout.write(JSON.stringify({ results, directedResults }));
});
