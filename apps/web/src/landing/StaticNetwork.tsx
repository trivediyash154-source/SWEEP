import { useMemo } from 'react';
import type { Graph, OptimizationRecord } from '@sweep/engine';
import { graphBounds } from '../lib/geometry';
import { NetworkLayers, type OverlayMode } from '../workspace/NetworkLayers';

/** Non-interactive, responsive rendering of a network for editorial figures and reports. */
export function StaticNetwork({
  graph,
  result = null,
  overlay = 'none',
  explainStep = 6,
  assumedWidth = 640,
  label,
  showWeights = false,
  showLabels = false,
  dimBase = false,
}: {
  graph: Graph;
  result?: OptimizationRecord | null;
  overlay?: OverlayMode;
  explainStep?: number;
  assumedWidth?: number;
  label: string;
  showWeights?: boolean;
  showLabels?: boolean;
  dimBase?: boolean;
}) {
  const b = useMemo(() => graphBounds(graph), [graph]);
  const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.06;
  const vb = { x: b.minX - pad, y: b.minY - pad, w: b.maxX - b.minX + pad * 2, h: b.maxY - b.minY + pad * 2 };
  const k = assumedWidth / vb.w;
  return (
    <svg viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} role="img" aria-label={label} className="static-net" preserveAspectRatio="xMidYMid meet">
      <NetworkLayers graph={graph} k={k} result={result} overlay={overlay} explainStep={explainStep} showWeights={showWeights} showLabels={showLabels} dimBase={dimBase} />
    </svg>
  );
}
