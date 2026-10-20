import { memo, useMemo } from 'react';
import type { Graph, OptimizationRecord, Point, SingleRouteRecord, ValidationReport } from '@sweep/engine';
import { edgeDrawPoints, midpoint, polylinePath, vertexMap } from '../lib/geometry';
import { formatNumber } from '../lib/format';
import '../styles/network.css';

export type OverlayMode = 'none' | 'route' | 'explain';

export interface NetworkLayersProps {
  graph: Graph;
  /** current zoom (screen px per world unit) — used to keep marks a constant size */
  k: number;
  result?: SingleRouteRecord | null;
  overlay?: OverlayMode;
  explainStep?: number;
  validation?: ValidationReport | null;
  selection?: { type: 'vertex' | 'edge'; id: string } | null;
  hover?: { type: 'vertex' | 'edge'; id: string } | null;
  pendingConnect?: string | null;
  highlightVertexIds?: string[];
  showWeights?: boolean;
  showLabels?: boolean;
  interactive?: boolean;
  dimBase?: boolean;
}

const COMPONENT_TINTS = ['var(--brand-rose)', 'var(--brand-cyan)', 'var(--brand-gold)', 'var(--brand-lavender)', 'var(--brand-coral)'];

export const NetworkLayers = memo(function NetworkLayers(props: NetworkLayersProps) {
  const { graph, k, result = null, overlay = 'none', explainStep = 0, validation = null } = props;
  const vm = useMemo(() => vertexMap(graph), [graph]);
  const edgePts = useMemo(() => new Map(graph.edges.map((e) => [e.id, edgeDrawPoints(e, vm)])), [graph, vm]);
  const r = 1 / k;
  const showWeights = props.showWeights ?? (graph.edges.length <= 90 && k > 0.35);
  const showLabels = props.showLabels ?? graph.vertices.length <= 40;

  // Required-subgraph degree, computed live for the odd-vertex hint.
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of graph.edges) {
      if (!e.required) continue;
      d.set(e.u, (d.get(e.u) ?? 0) + 1);
      d.set(e.v, (d.get(e.v) ?? 0) + 1);
    }
    return d;
  }, [graph]);

  const componentOf = useMemo(() => {
    const map = new Map<string, number>();
    if (validation && validation.requiredComponents.length > 1) validation.requiredComponents.forEach((c, i) => c.forEach((v) => map.set(v, i)));
    return map;
  }, [validation]);
  const connectorIds = useMemo(() => new Set(validation?.connectorSuggestion?.edgeIds ?? []), [validation]);

  const resultUsable = !!result && (overlay === 'route' || overlay === 'explain');
  const step = overlay === 'explain' ? explainStep : 99;
  // Explain-only overlays exist for undirected records; directed records carry balance data instead.
  const undirected: OptimizationRecord | null = result && result.mode !== 'directed' ? (result as OptimizationRecord) : null;
  const oddSet = useMemo(() => new Set(undirected?.oddVertexIds ?? []), [undirected]);
  const added = result ? (result.mode === 'directed' ? result.augmentation.addedEdgeCopies : result.augmentation.addedCopies) : {};
  const counts = result?.route.traversalCounts ?? {};

  const pathOf = (id: string): string => polylinePath(edgePts.get(id) ?? []);

  return (
    <g className="net">
      {/* component tint for disconnected required groups */}
      {componentOf.size > 0 && (
        <g className="net-tint">
          {graph.edges.map((e) =>
            e.required && componentOf.has(e.u) ? (
              <path key={e.id} d={pathOf(e.id)} stroke={COMPONENT_TINTS[componentOf.get(e.u)! % COMPONENT_TINTS.length]} className="net-tint__edge" />
            ) : null,
          )}
        </g>
      )}

      {/* base streets */}
      <g className={`net-edges${props.dimBase ? ' is-dim' : ''}`}>
        {graph.edges.map((e) => {
          const sel = props.selection?.type === 'edge' && props.selection.id === e.id;
          const hov = props.hover?.type === 'edge' && props.hover.id === e.id;
          return (
            <g key={e.id} className={`net-edge ${e.required ? 'is-required' : 'is-optional'}${sel ? ' is-selected' : ''}${hov ? ' is-hover' : ''}`}>
              {(sel || hov) && <path d={pathOf(e.id)} className="net-edge__halo" />}
              <path d={pathOf(e.id)} className="net-edge__line" />
              {props.interactive && <path d={pathOf(e.id)} className="net-edge__hit" data-eid={e.id} />}
            </g>
          );
        })}
      </g>

      {connectorIds.size > 0 && (
        <g className="net-connectors">
          {graph.edges.filter((e) => connectorIds.has(e.id)).map((e) => (
            <path key={e.id} d={pathOf(e.id)} className="net-connector" />
          ))}
        </g>
      )}

      {/* optimised route (compose view or final explain steps) */}
      {resultUsable && (overlay === 'route' || step >= 6) && (
        <g className="net-route" aria-hidden="true">
          {graph.edges.map((e) =>
            (counts[e.id] ?? 0) > 0 ? <path key={e.id} d={pathOf(e.id)} className={`net-route__edge${!e.required ? ' is-deadhead' : ''}`} /> : null,
          )}
        </g>
      )}

      {/* augmentation: duplicated shortest paths */}
      {resultUsable && step >= 4 && (
        <g className="net-repeat" aria-hidden="true">
          {Object.keys(added).map((id) => {
            const e = graph.edges.find((x) => x.id === id);
            if (!e) return null;
            return <path key={id} d={pathOf(id)} className={`net-repeat__edge${e.required ? '' : ' is-deadhead'}`} />;
          })}
        </g>
      )}

      {/* explain: auxiliary complete graph on odd vertices */}
      {undirected && overlay === 'explain' && step === 2 && undirected.oddVertexIds.length <= 24 && (
        <g className="net-chords" aria-hidden="true">
          {undirected.oddVertexIds.flatMap((a, i) =>
            undirected.oddVertexIds.slice(i + 1).map((b, jj) => {
              const pa = vm.get(a);
              const pb = vm.get(b);
              if (!pa || !pb) return null;
              const d = undirected.oddDistanceMatrix?.[i]?.[i + 1 + jj];
              return (
                <g key={`${a}-${b}`}>
                  <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} className="net-chord" />
                  {d !== undefined && undirected.oddVertexIds.length <= 8 && (
                    <text x={(pa.x + pb.x) / 2} y={(pa.y + pb.y) / 2} className="net-label net-label--chord" style={{ fontSize: 11 * r }}>
                      {formatNumber(d)}
                    </text>
                  )}
                </g>
              );
            }),
          )}
        </g>
      )}

      {/* explain: chosen minimum matching */}
      {undirected && overlay === 'explain' && step === 3 && (
        <g className="net-matching" aria-hidden="true">
          {undirected.matching.pairs.map((p) => {
            const pa = vm.get(p.a);
            const pb = vm.get(p.b);
            if (!pa || !pb) return null;
            return (
              <g key={`${p.a}-${p.b}`}>
                <line x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} className="net-match" />
                {undirected.matching.pairs.length <= 12 && (
                  <text x={(pa.x + pb.x) / 2} y={(pa.y + pb.y) / 2} className="net-label net-label--match" style={{ fontSize: 12 * r }}>
                    {formatNumber(p.distance)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      )}

      {/* weights */}
      {showWeights && (
        <g className="net-weights" aria-hidden="true">
          {graph.edges.map((e) => {
            const pts = edgePts.get(e.id);
            if (!pts || pts.length < 2) return null;
            const [x, y] = midpoint(pts as Point[]);
            const c = counts[e.id] ?? 0;
            const showCount = resultUsable && step >= 4 && c >= 2;
            return (
              <text key={e.id} x={x} y={y} className={`net-label net-label--weight${e.required ? '' : ' is-optional'}`} style={{ fontSize: 10.5 * r }}>
                {formatNumber(e.weight, e.weight % 1 === 0 ? 0 : 1)}
                {showCount ? <tspan className="net-label__count">{` ×${c}`}</tspan> : null}
              </text>
            );
          })}
        </g>
      )}

      {/* vertices */}
      <g className="net-vertices">
        {graph.vertices.map((v) => {
          const deg = degree.get(v.id) ?? 0;
          const odd = deg % 2 === 1;
          const sel = props.selection?.type === 'vertex' && props.selection.id === v.id;
          const hov = props.hover?.type === 'vertex' && props.hover.id === v.id;
          const pending = props.pendingConnect === v.id;
          const hl = props.highlightVertexIds?.includes(v.id);
          const explainOdd = resultUsable && overlay === 'explain' && step >= 1 && step <= 3 && oddSet.has(v.id);
          const tint = componentOf.get(v.id);
          return (
            <g key={v.id} transform={`translate(${v.x},${v.y})`} className={`net-vertex${odd ? ' is-odd' : ''}${sel ? ' is-selected' : ''}${hov ? ' is-hover' : ''}${pending ? ' is-pending' : ''}${hl ? ' is-flagged' : ''}${deg === 0 ? ' is-isolated' : ''}`}>
              {(explainOdd || (odd && overlay !== 'explain')) && <circle r={(explainOdd ? 11 : 8.5) * r} className={`net-vertex__odd${explainOdd ? ' is-strong' : ''}`} />}
              {(sel || pending || hl) && <circle r={12 * r} className="net-vertex__halo" />}
              <circle r={(deg === 0 ? 3.5 : 4.6) * r} className="net-vertex__dot" style={tint !== undefined ? { fill: COMPONENT_TINTS[tint % COMPONENT_TINTS.length] } : undefined} />
              {props.interactive && <circle r={11 * r} className="net-vertex__hit" data-vid={v.id} />}
              {overlay === 'explain' && step === 1 && deg > 0 && (
                <text y={-12 * r} className={`net-label net-label--degree${odd ? ' is-odd' : ''}`} style={{ fontSize: 11 * r }}>
                  {deg}
                </text>
              )}
              {showLabels && !(overlay === 'explain' && step === 1) && (
                <text x={8 * r} y={-8 * r} className="net-label net-label--vertex" style={{ fontSize: 10.5 * r }}>
                  {v.label ?? v.id}
                </text>
              )}
            </g>
          );
        })}
      </g>

      {/* depot */}
      {(() => {
        const depotId = result?.input.depotId ?? graph.depotId;
        const p = depotId ? vm.get(depotId) : undefined;
        if (!p) return null;
        return (
          <g transform={`translate(${p.x},${p.y})`} className="net-depot" aria-hidden="true">
            <path d={`M0,${-9 * r}L${7 * r},0L0,${9 * r}L${-7 * r},0Z`} />
            <text y={20 * r} className="net-label net-label--depot" style={{ fontSize: 9.5 * r }}>
              START
            </text>
          </g>
        );
      })()}
    </g>
  );
});
