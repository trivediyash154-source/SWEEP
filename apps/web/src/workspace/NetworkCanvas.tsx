import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type KeyboardEvent as RKeyboardEvent } from 'react';
import { useWorkspace } from '../state/workspace';
import { graphBounds, buildRouteGeometry, polylinePath, sampleRoute } from '../lib/geometry';
import { NetworkLayers } from './NetworkLayers';
import { routeClock } from './routeClock';
import { useReducedMotion } from '../state/prefs';

interface View {
  k: number;
  tx: number;
  ty: number;
}

const MIN_K = 0.02;
const MAX_K = 12;

/**
 * Interactive 2D network editor and route renderer (SVG).
 * Marks keep a constant on-screen size: strokes use non-scaling-stroke and
 * radii are divided by the zoom factor.
 */
export function NetworkCanvas() {
  const ws = useWorkspace();
  const { graph, tool, view: wsView, result, resultGraph, stale, explainStep } = ws;
  const reduced = useReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ kind: 'pan' | 'move'; id?: string; startX: number; startY: number; tx: number; ty: number; moved: boolean } | null>(null);
  const [cursorWorld, setCursorWorld] = useState<{ x: number; y: number } | null>(null);

  // ---- sizing & fit -----------------------------------------------------
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      setSize({ w: Math.max(200, r.width), h: Math.max(200, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    const b = graphBounds(graph);
    // Leave room for the overlays: legend (top), tool dock (left), bottom bar.
    const narrow = size.w < 700;
    const inset = { left: narrow ? 24 : 92, right: 40, top: narrow ? 56 : 84, bottom: wsView === 'explain' ? (narrow ? 210 : 190) : narrow ? 90 : 120 };
    const bw = b.maxX - b.minX;
    const bh = b.maxY - b.minY;
    const availW = Math.max(120, size.w - inset.left - inset.right);
    const availH = Math.max(120, size.h - inset.top - inset.bottom);
    const k = Math.max(MIN_K, Math.min(MAX_K, Math.min(availW / bw, availH / bh)));
    setView({ k, tx: inset.left + availW / 2 - ((b.minX + b.maxX) / 2) * k, ty: inset.top + availH / 2 - ((b.minY + b.maxY) / 2) * k });
    // Refit only on resize, view change or an explicit request (fitNonce), never on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, ws.fitNonce, wsView]);
  useEffect(() => {
    fit();
  }, [fit]);

  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - rect.left - v.tx) / v.k, y: (clientY - rect.top - v.ty) / v.k };
  };

  // ---- wheel zoom (non-passive so the page does not scroll) ---------------
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const k = Math.max(MIN_K, Math.min(MAX_K, v.k * Math.exp(-e.deltaY * 0.0016)));
        return { k, tx: px - (px - v.tx) * (k / v.k), ty: py - (py - v.ty) * (k / v.k) };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  // ---- route animation ------------------------------------------------------
  const showResult = !!result && !!resultGraph && !stale;
  const animGraph = showResult ? resultGraph! : graph;
  const geo = useMemo(() => (showResult ? buildRouteGeometry(resultGraph!, result!.route.steps) : null), [showResult, result, resultGraph]);
  const trailRef = useRef<SVGPathElement>(null);
  const vehicleRef = useRef<SVGGElement>(null);
  const routeVisible = showResult && (wsView === 'compose' || (wsView === 'explain' && explainStep >= 5));

  useEffect(() => {
    if (!geo) return;
    routeClock.setTotal(geo.totalDrawn);
    if (wsView === 'explain' && explainStep === 5) {
      routeClock.seek(0);
      if (!reduced) routeClock.play();
      else routeClock.seek(geo.totalDrawn);
    }
  }, [geo, wsView, explainStep, reduced]);

  useEffect(() => {
    if (!geo || !routeVisible) return;
    return routeClock.subscribe((s) => {
      const trail = trailRef.current;
      const veh = vehicleRef.current;
      if (trail) {
        trail.style.strokeDasharray = `${geo.totalDrawn} ${geo.totalDrawn + 1}`;
        trail.style.strokeDashoffset = `${geo.totalDrawn - s}`;
      }
      if (veh) {
        const sample = sampleRoute(geo, s);
        veh.setAttribute('transform', `translate(${sample.point[0]},${sample.point[1]}) rotate(${(sample.angle * 180) / Math.PI})`);
        veh.style.opacity = s > 0 && s < geo.totalDrawn ? '1' : '0';
      }
    });
  }, [geo, routeVisible]);

  const trailD = useMemo(() => (geo ? polylinePath(geo.points) : ''), [geo]);

  // ---- pointer interaction ----------------------------------------------------
  const hitTarget = (e: RPointerEvent): { vid?: string; eid?: string } => {
    const t = e.target as Element;
    return { vid: t.getAttribute('data-vid') ?? undefined, eid: t.getAttribute('data-eid') ?? undefined };
  };

  const onPointerDown = (e: RPointerEvent<SVGSVGElement>): void => {
    if (e.button === 1 || e.button === 2) return;
    const { vid, eid } = hitTarget(e);
    const st = useWorkspace.getState();
    const panStart = () => {
      drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, tx: viewRef.current.tx, ty: viewRef.current.ty, moved: false };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    };
    if (wsView !== 'compose') {
      panStart();
      return;
    }
    switch (tool) {
      case 'select':
        if (vid) {
          st.select({ type: 'vertex', id: vid });
          drag.current = { kind: 'move', id: vid, startX: e.clientX, startY: e.clientY, tx: 0, ty: 0, moved: false };
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
        } else if (eid) st.select({ type: 'edge', id: eid });
        else {
          st.select(null);
          panStart();
        }
        break;
      case 'add':
        if (!vid && !eid) {
          const w = toWorld(e.clientX, e.clientY);
          st.addVertex(w.x, w.y);
        } else panStart();
        break;
      case 'connect':
        if (vid) {
          if (st.pendingConnect && st.pendingConnect !== vid) {
            st.connect(st.pendingConnect, vid);
            st.setPendingConnect(vid);
          } else st.setPendingConnect(st.pendingConnect === vid ? null : vid);
        } else panStart();
        break;
      case 'required':
        if (eid) {
          const edge = st.graph.edges.find((x) => x.id === eid);
          if (edge) st.updateEdge(eid, { required: !edge.required });
        } else panStart();
        break;
      case 'delete':
        if (vid) st.removeVertex(vid);
        else if (eid) st.removeEdge(eid);
        else panStart();
        break;
      case 'depot':
        if (vid) st.setDepot(vid);
        else panStart();
        break;
    }
  };

  const onPointerMove = (e: RPointerEvent<SVGSVGElement>): void => {
    const d = drag.current;
    if (wsView === 'compose' && tool === 'connect') setCursorWorld(toWorld(e.clientX, e.clientY));
    if (!d) {
      const { vid, eid } = hitTarget(e);
      const cur = useWorkspace.getState().hover;
      const next = vid ? { type: 'vertex' as const, id: vid } : eid ? { type: 'edge' as const, id: eid } : null;
      if (cur?.id !== next?.id || cur?.type !== next?.type) useWorkspace.getState().setHover(next);
      return;
    }
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    if (d.kind === 'pan') {
      d.moved = true;
      setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }));
    } else if (d.kind === 'move' && d.id) {
      if (!d.moved) useWorkspace.getState().beginMove();
      d.moved = true;
      const w = toWorld(e.clientX, e.clientY);
      useWorkspace.getState().moveVertex(d.id, w.x, w.y, false);
    }
  };

  const onPointerUp = (e: RPointerEvent<SVGSVGElement>): void => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'move' && d.moved && d.id) {
      const w = toWorld(e.clientX, e.clientY);
      useWorkspace.getState().moveVertex(d.id, w.x, w.y, true);
    }
  };

  const onKeyDown = (e: RKeyboardEvent<HTMLDivElement>): void => {
    const step = 60;
    if (e.key === 'ArrowLeft') setView((v) => ({ ...v, tx: v.tx + step }));
    else if (e.key === 'ArrowRight') setView((v) => ({ ...v, tx: v.tx - step }));
    else if (e.key === 'ArrowUp') setView((v) => ({ ...v, ty: v.ty + step }));
    else if (e.key === 'ArrowDown') setView((v) => ({ ...v, ty: v.ty - step }));
    else if (e.key === '+' || e.key === '=') zoomBy(1.25);
    else if (e.key === '-' || e.key === '_') zoomBy(0.8);
    else return;
    e.preventDefault();
  };

  const zoomBy = (f: number): void =>
    setView((v) => {
      const k = Math.max(MIN_K, Math.min(MAX_K, v.k * f));
      const cx = size.w / 2;
      const cy = size.h / 2;
      return { k, tx: cx - (cx - v.tx) * (k / v.k), ty: cy - (cy - v.ty) * (k / v.k) };
    });

  const pendingVertex = ws.pendingConnect ? graph.vertices.find((v) => v.id === ws.pendingConnect) : null;
  const overlay = wsView === 'explain' ? 'explain' : showResult ? 'route' : 'none';

  return (
    <div
      ref={wrapRef}
      className={`net-canvas tool-${tool} view-${wsView}`}
      tabIndex={0}
      role="application"
      aria-label={`Street network canvas: ${graph.vertices.length} intersections and ${graph.edges.length} streets. Use the tool dock or keyboard shortcuts to edit; arrow keys pan, plus and minus zoom.`}
      onKeyDown={onKeyDown}
      data-testid="network-canvas"
    >
      <svg ref={svgRef} width={size.w} height={size.h} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => useWorkspace.getState().setHover(null)}>
        <defs>
          <pattern id="net-dots" width={40} height={40} patternUnits="userSpaceOnUse" patternTransform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
            <circle cx={1} cy={1} r={1 / Math.max(0.5, view.k)} className="net-dot" />
          </pattern>
        </defs>
        <rect width={size.w} height={size.h} fill="url(#net-dots)" className="net-bg" />
        <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
          <NetworkLayers
            graph={overlay === 'none' ? graph : animGraph}
            k={view.k}
            result={showResult ? result : null}
            overlay={overlay}
            explainStep={explainStep}
            validation={ws.failure ?? ws.validation}
            selection={ws.selection}
            hover={ws.hover}
            pendingConnect={ws.pendingConnect}
            highlightVertexIds={ws.highlight}
            interactive={wsView === 'compose'}
            dimBase={overlay === 'explain' && explainStep >= 4}
          />
          {routeVisible && geo && (
            <g className="net-anim" aria-hidden="true">
              <path ref={trailRef} d={trailD} className="net-trail" style={{ strokeWidth: 3.2 / view.k }} />
              <g ref={vehicleRef} className="net-vehicle" style={{ opacity: 0 }}>
                <circle r={13 / view.k} className="net-vehicle__glow" />
                <path d={`M${-6 / view.k},${-5 / view.k}L${7 / view.k},0L${-6 / view.k},${5 / view.k}Z`} className="net-vehicle__body" />
              </g>
            </g>
          )}
          {pendingVertex && cursorWorld && wsView === 'compose' && tool === 'connect' && (
            <line x1={pendingVertex.x} y1={pendingVertex.y} x2={cursorWorld.x} y2={cursorWorld.y} className="net-ghost" />
          )}
        </g>
      </svg>
      <div className="net-zoom" role="group" aria-label="Zoom">
        <button type="button" className="btn btn--quiet btn--icon btn--sm" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
          +
        </button>
        <button type="button" className="btn btn--quiet btn--icon btn--sm" onClick={() => zoomBy(0.8)} aria-label="Zoom out">
          −
        </button>
        <button type="button" className="btn btn--quiet btn--sm" onClick={fit} aria-label="Fit network to view">
          Fit
        </button>
        <span className="net-zoom__scale mono">{Math.round(view.k * 100)}%</span>
      </div>
    </div>
  );
}
