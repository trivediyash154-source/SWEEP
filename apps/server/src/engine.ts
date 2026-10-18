export * from '@sweep/engine';
import { EXAMPLES, getExample } from '@sweep/engine/examples';
import type { Graph } from '@sweep/engine';

export const EXAMPLES_META = EXAMPLES.map(({ graph, ...meta }) => ({ ...meta, vertexCount: graph.vertices.length, edgeCount: graph.edges.length }));

export function getExampleGraph(id: string): Graph | undefined {
  return getExample(id)?.graph;
}
