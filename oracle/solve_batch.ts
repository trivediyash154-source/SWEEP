/**
 * Bridge used by the Python oracle: reads {"graphs": Graph[]} from stdin and
 * writes the SWEEP engine's answers to stdout as JSON.
 */
import { solveChinesePostman, verifyRoute } from '../packages/engine/src/index.js';
import { EXAMPLES } from '../packages/engine/src/examples/index.js';

const chunks: Buffer[] = [];
process.stdin.on('data', (c: Buffer) => chunks.push(c));
process.stdin.on('end', () => {
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { graphs: unknown[]; includeExamples?: boolean };
  const graphs = [...(input.graphs as Parameters<typeof solveChinesePostman>[0][])];
  const names: string[] = graphs.map((_, i) => `random-${i}`);
  if (input.includeExamples) {
    for (const ex of EXAMPLES) {
      graphs.push(ex.graph);
      names.push(`example:${ex.id}`);
    }
  }
  const results = graphs.map((g, i) => {
    const r = solveChinesePostman(g, { limits: { maxOddVertices: 2000 } });
    if (!r.ok) return { name: names[i], graph: names[i]!.startsWith('example:') ? g : undefined, ok: false, codes: r.validation.issues.filter((x) => x.severity === 'error').map((x) => x.code) };
    const v = verifyRoute(g, r.route.steps, { depotId: r.input.depotId, expectedTotal: r.route.totalDistance });
    return {
      name: names[i],
      graph: names[i]!.startsWith('example:') ? g : undefined,
      ok: true,
      total: r.route.totalDistance,
      required: r.route.requiredDistance,
      odd: r.oddVertexIds.length,
      checksPassed: r.checks.every((c) => c.passed) && v.ok,
      steps: r.route.steps.map((s) => [s.edgeId, s.from, s.to]),
      depot: r.input.depotId,
    };
  });
  process.stdout.write(JSON.stringify({ results }));
});
