import { useEffect, useMemo, useRef } from 'react';
import type { Graph, Point } from '@sweep/engine';
import { isOneway } from '@sweep/engine';
import { edgeDrawPoints, graphBounds, vertexMap } from '../lib/geometry';
import { sampleTrack, type RouteTrack } from '../lib/routeTrack';
import { spectralCss, type ThemeName } from '../lib/spectral';
import type { Highlight } from '../lib/analysis';
import { routeClock } from './routeClock';
import { useWorkspace } from '../state/workspace';

const PAL = {
  velvet: {
    required: 'rgba(241,230,214,0.55)',
    optional: 'rgba(125,111,143,0.45)',
    vertex: 'rgba(241,230,214,0.8)',
    ghost: 'rgba(241,230,214,0.12)',
    repeat: '#ff6d86',
    deadhead: '#e9c98c',
    text: '#f6efe6',
    textBg: 'rgba(29,15,46,0.82)',
    marks: { odd: '#b7a6ff', even: '#8b7aa8', surplus: '#ff9d6d', deficit: '#75e0ff', matched: '#ffd98c', focus: '#ffffff', path: '#ffd98c', added: '#ff6d86', hover: '#f3a7c4' },
    depot: '#e9c98c',
    arrow: 'rgba(255,217,140,0.7)',
  },
  porcelain: {
    required: 'rgba(44,26,58,0.55)',
    optional: 'rgba(120,108,130,0.35)',
    vertex: 'rgba(44,26,58,0.75)',
    ghost: 'rgba(44,26,58,0.1)',
    repeat: '#d23c5a',
    deadhead: '#9a6d1f',
    text: '#24152f',
    textBg: 'rgba(251,248,242,0.9)',
    marks: { odd: '#6148d1', even: '#a99db0', surplus: '#c4572a', deficit: '#0a7ea6', matched: '#9a6d1f', focus: '#2c1a3a', path: '#9a6d1f', added: '#d23c5a', hover: '#c23d78' },
    depot: '#9a6d1f',
    arrow: 'rgba(44,26,58,0.55)',
  },
} as const;

export interface RouteProjectionProps {
  graph: Graph;
  tracks: RouteTrack[];
  trackColors: Array<string | null>;
  theme: ThemeName;
  reduced: boolean;
  highlight: Highlight;
  depotId: string | null;
  showOrder?: boolean;
  interactive?: boolean;
  label: string;
  testId?: string;
}

interface Xf {
  k: number;
  tx: number;
  ty: number;
}

export function RouteProjection(props: RouteProjectionProps) {
  const { graph, tracks, trackColors, theme, reduced, highlight, depotId, showOrder = true, interactive = true } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const xf = useRef<Xf>({ k: 1, tx: 0, ty: 0 });
  const userMoved = useRef(false);
  const size = useRef({ w: 600, h: 400, dpr: 1 });
  const dirty = useRef(true);
  const visible = useRef(true);
  const timeRef = useRef(0);

  const vm = useMemo(() => vertexMap(graph), [graph]);
  const edgePts = useMemo(() => new Map(graph.edges.map((e) => [e.id, edgeDrawPoints(e, vm)])), [graph, vm]);
  const bounds = useMemo(() => graphBounds(graph), [graph]);
  const segIndex = useMemo(() => {
    const list: Array<{ id: string; a: Point; b: Point }> = [];
    for (const e of graph.edges) {
      const p = edgePts.get(e.id) ?? [];
      for (let i = 1; i < p.length; i++) list.push({ id: e.id, a: p[i - 1]!, b: p[i]! });
    }
    return list;
  }, [graph, edgePts]);

  const fit = () => {
    const { w, h } = size.current;
    const pad = Math.min(w, h) * 0.08 + 12;
    const bw = bounds.maxX - bounds.minX;
    const bh = bounds.maxY - bounds.minY;
    const k = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
    xf.current = { k, tx: w / 2 - ((bounds.minX + bounds.maxX) / 2) * k, ty: h / 2 - ((bounds.minY + bounds.maxY) / 2) * k };
    dirty.current = true;
  };

  // sizing
  useEffect(() => {
    const el = wrap.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry!.contentRect;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      size.current = { w: Math.max(100, r.width), h: Math.max(100, r.height), dpr };
      cv.width = Math.floor(size.current.w * dpr);
      cv.height = Math.floor(size.current.h * dpr);
      cv.style.width = `${size.current.w}px`;
      cv.style.height = `${size.current.h}px`;
      if (!userMoved.current) fit();
      dirty.current = true;
    });
    ro.observe(el);
    const io = new IntersectionObserver(([e]) => {
      visible.current = !!e?.isIntersecting;
      dirty.current = true;
    });
    io.observe(el);
    return () => {
      ro.disconnect();
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    userMoved.current = false;
    fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds]);

  useEffect(() => {
    dirty.current = true;
  }, [graph, tracks, theme, highlight, showOrder, depotId]);

  useEffect(() => routeClock.subscribe(() => (dirty.current = true)), []);
  useEffect(
    () =>
      useWorkspace.subscribe((s, prev) => {
        if (s.hover !== prev.hover || s.selection !== prev.selection) dirty.current = true;
      }),
    [],
  );

  // render loop
  useEffect(() => {
    const cv = canvas.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    let raf = 0;
    let last = performance.now();
    const pal = PAL[theme];
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const animate = !reduced && tracks.length > 0;
      if (animate) timeRef.current += dt;
      if (visible.current && (dirty.current || animate)) {
        dirty.current = false;
        draw(ctx, pal);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, reduced, tracks, graph, highlight, showOrder, depotId]);

  function draw(ctx: CanvasRenderingContext2D, pal: (typeof PAL)[ThemeName]) {
    const { w, h, dpr } = size.current;
    const { k, tx, ty } = xf.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const X = (p: Point) => p[0] * k + tx;
    const Y = (p: Point) => p[1] * k + ty;
    const ws = useWorkspace.getState();
    const t = timeRef.current;
    const line = (pts: Point[]) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p), Y(p)) : ctx.lineTo(X(p), Y(p))));
    };
    const base = Math.max(1, Math.min(4, k * 3));

    // streets
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const dim = highlight.dimBase ? 0.45 : 1;
    for (const e of graph.edges) {
      const pts = edgePts.get(e.id) ?? [];
      ctx.globalAlpha = dim;
      ctx.strokeStyle = e.required ? pal.required : pal.optional;
      ctx.lineWidth = e.required ? base * 1.6 : base * 0.9;
      line(pts);
      ctx.stroke();
      if (isOneway(e) && pts.length >= 2) {
        const a = pts[Math.floor((pts.length - 1) / 2)]!;
        const b = pts[Math.floor((pts.length - 1) / 2) + 1] ?? pts[pts.length - 1]!;
        const ang = Math.atan2(Y(b) - Y(a), X(b) - X(a));
        const mx = (X(a) + X(b)) / 2;
        const my = (Y(a) + Y(b)) / 2;
        const s = Math.max(4, base * 2.6);
        ctx.fillStyle = pal.arrow;
        ctx.beginPath();
        ctx.moveTo(mx + Math.cos(ang) * s, my + Math.sin(ang) * s);
        ctx.lineTo(mx + Math.cos(ang + 2.5) * s, my + Math.sin(ang + 2.5) * s);
        ctx.lineTo(mx + Math.cos(ang - 2.5) * s, my + Math.sin(ang - 2.5) * s);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // analysis highlights on streets
    for (const [id, mark] of highlight.edges) {
      const pts = edgePts.get(id);
      if (!pts) continue;
      ctx.strokeStyle = pal.marks[mark];
      ctx.lineWidth = base * (mark === 'focus' ? 4 : 3);
      ctx.setLineDash(mark === 'path' ? [base * 3, base * 2.2] : []);
      line(pts);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const sel of [ws.hover, ws.selection]) {
      if (sel?.type === 'edge') {
        const pts = edgePts.get(sel.id);
        if (!pts) continue;
        ctx.strokeStyle = sel === ws.selection ? pal.marks.focus : pal.marks.hover;
        ctx.lineWidth = base * 4;
        line(pts);
        ctx.stroke();
      }
    }

    // routes
    const active = routeClock.s > 0 || routeClock.playing;
    const showOnly = ws.activeVehicle > 0 && tracks.length > 1 ? ws.activeVehicle - 1 : -1;
    if (highlight.showRoute) {
      tracks.forEach((tr, ti) => {
        if (showOnly >= 0 && ti !== showOnly) return;
        const head = active ? Math.min(routeClock.s, tr.total) : tr.total;
        const cycle = Math.max(tr.total / 3, 1);
        const tint = trackColors[ti];
        // ghost of the full route
        ctx.strokeStyle = pal.ghost;
        ctx.lineWidth = base * 2.2;
        line(tr.points);
        ctx.stroke();
        // driven portion, coloured by true distance, with a travelling light band
        const P = tr.points;
        const D = tr.pointDist;
        const chunk = 4;
        for (let i = 0; i + 1 < P.length; i += chunk) {
          const j = Math.min(P.length - 1, i + chunk);
          if (D[i]! > head) break;
          const dm = (D[i]! + D[j]!) / 2;
          const phase = (((dm - t * cycle * 0.09) / (cycle * 0.5)) % 1 + 1) % 1;
          const band = Math.exp(-(((phase - 0.5) * 8) ** 2));
          ctx.strokeStyle = tint ?? spectralCss(dm / cycle - t * 0.045, theme);
          ctx.lineWidth = base * (2.1 + band * 1.6);
          ctx.globalAlpha = 0.78 + band * 0.22;
          ctx.beginPath();
          ctx.moveTo(X(P[i]!), Y(P[i]!));
          for (let q = i + 1; q <= j; q++) {
            if (D[q]! > head) break;
            ctx.lineTo(X(P[q]!), Y(P[q]!));
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        // repeated and deadhead traversals
        tr.steps.forEach((st, si) => {
          if (st.kind === 'service' || tr.cumDist[si]! > head) return;
          ctx.strokeStyle = st.kind === 'repeat' ? pal.repeat : pal.deadhead;
          ctx.lineWidth = base * 1.2;
          ctx.setLineDash([base * 2.4, base * 2]);
          line(tr.stepPoints[si]!);
          ctx.stroke();
        });
        ctx.setLineDash([]);
        // traversal order
        if (showOrder && tracks.length === 1) {
          const n = tr.steps.length;
          const every = n <= 60 ? 1 : Math.ceil(n / 60);
          ctx.font = `600 ${Math.max(9, Math.min(11, base * 4))}px "JetBrains Mono", monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          for (let si = 0; si < n; si += every) {
            if (tr.cumDist[si]! > head) break;
            const pts = tr.stepPoints[si]!;
            const mid = pts[Math.floor(pts.length / 2)] ?? pts[0];
            if (!mid) continue;
            const x = X(mid);
            const y = Y(mid);
            const label = String(si + 1);
            const r = 6 + label.length * 2.4;
            ctx.fillStyle = pal.textBg;
            ctx.beginPath();
            ctx.ellipse(x, y, r, 7.5, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = tr.steps[si]!.kind === 'repeat' ? pal.repeat : pal.text;
            ctx.fillText(label, x, y + 0.5);
          }
        }
        // vehicle and leading glow
        const smp = sampleTrack(tr, active ? head : 0);
        const vx = X(smp.point);
        const vy = Y(smp.point);
        const g = ctx.createRadialGradient(vx, vy, 0, vx, vy, 22);
        g.addColorStop(0, theme === 'velvet' ? 'rgba(255,248,235,0.95)' : 'rgba(44,26,58,0.5)');
        g.addColorStop(0.35, tint ?? spectralCss(head / cycle - t * 0.045, theme, 0.55));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(vx, vy, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.translate(vx, vy);
        ctx.rotate(smp.angle);
        ctx.fillStyle = theme === 'velvet' ? '#fff4e0' : '#2c1a3a';
        ctx.beginPath();
        ctx.moveTo(8, 0);
        ctx.lineTo(-6, 5);
        ctx.lineTo(-6, -5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      });
    }

    // intersections
    for (const v of graph.vertices) {
      const x = v.x * k + tx;
      const y = v.y * k + ty;
      const mark = highlight.vertices.get(v.id);
      ctx.fillStyle = pal.vertex;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1.6, base * 0.9), 0, Math.PI * 2);
      ctx.fill();
      if (mark) {
        ctx.strokeStyle = pal.marks[mark];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(6, base * 3), 0, Math.PI * 2);
        ctx.stroke();
      }
      const lbl = highlight.labels.get(v.id);
      if (lbl && highlight.labels.size <= 120) {
        ctx.font = '600 11px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillStyle = pal.textBg;
        const tw = ctx.measureText(lbl).width + 8;
        ctx.fillRect(x - tw / 2, y - 24, tw, 15);
        ctx.fillStyle = mark ? pal.marks[mark] : pal.text;
        ctx.fillText(lbl, x, y - 16);
      }
    }
    for (const sel of [ws.hover, ws.selection]) {
      if (sel?.type !== 'vertex') continue;
      const p = vm.get(sel.id);
      if (!p) continue;
      ctx.strokeStyle = sel === ws.selection ? pal.marks.focus : pal.marks.hover;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(p.x * k + tx, p.y * k + ty, Math.max(8, base * 3.6), 0, Math.PI * 2);
      ctx.stroke();
    }

    // depot: start and end of the closed loop
    const dp = depotId ? vm.get(depotId) : undefined;
    if (dp) {
      const x = dp.x * k + tx;
      const y = dp.y * k + ty;
      ctx.fillStyle = pal.depot;
      ctx.beginPath();
      ctx.moveTo(x, y - 9);
      ctx.lineTo(x + 7, y);
      ctx.lineTo(x, y + 9);
      ctx.lineTo(x - 7, y);
      ctx.closePath();
      ctx.fill();
      if (tracks.length > 0) {
        ctx.strokeStyle = pal.depot;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 15, -Math.PI * 0.15, Math.PI * 1.6);
        ctx.stroke();
        const ex = x + 15 * Math.cos(Math.PI * 1.6);
        const ey = y + 15 * Math.sin(Math.PI * 1.6);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex + 5, ey - 1);
        ctx.lineTo(ex + 1, ey + 5);
        ctx.fill();
      }
      ctx.font = '600 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = pal.text;
      ctx.fillText(tracks.length > 0 ? 'START = END' : 'START', x, y + 27);
    }
  }

  // ---- interaction ---------------------------------------------------------
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const pick = (cx: number, cy: number): { type: 'vertex' | 'edge'; id: string } | null => {
    const { k, tx, ty } = xf.current;
    let best: { d: number; id: string } | null = null;
    for (const v of graph.vertices) {
      const d = Math.hypot(v.x * k + tx - cx, v.y * k + ty - cy);
      if (d < 11 && (!best || d < best.d)) best = { d, id: v.id };
    }
    if (best) return { type: 'vertex', id: best.id };
    let be: { d: number; id: string } | null = null;
    for (const s of segIndex) {
      const ax = s.a[0] * k + tx;
      const ay = s.a[1] * k + ty;
      const bx = s.b[0] * k + tx;
      const by = s.b[1] * k + ty;
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const u = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / l2));
      const d = Math.hypot(cx - (ax + u * dx), cy - (ay + u * dy));
      if (d < 7 && (!be || d < be.d)) be = { d, id: s.id };
    }
    return be ? { type: 'edge', id: be.id } : null;
  };
  const local = (e: React.PointerEvent | React.MouseEvent | WheelEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !interactive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const f = Math.exp(-e.deltaY * 0.0015);
      const v = xf.current;
      xf.current = { k: v.k * f, tx: p.x - (p.x - v.tx) * f, ty: p.y - (p.y - v.ty) * f };
      userMoved.current = true;
      dirty.current = true;
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  }, [interactive]);

  return (
    <div ref={wrap} className="projection" data-testid={props.testId}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={props.label}
        tabIndex={interactive ? 0 : -1}
        onPointerDown={(e) => {
          if (!interactive) return;
          drag.current = { x: e.clientX, y: e.clientY, tx: xf.current.tx, ty: xf.current.ty, moved: false };
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!interactive) return;
          const d = drag.current;
          if (d) {
            const dx = e.clientX - d.x;
            const dy = e.clientY - d.y;
            if (d.moved || Math.hypot(dx, dy) > 3) {
              d.moved = true;
              userMoved.current = true;
              xf.current = { ...xf.current, tx: d.tx + dx, ty: d.ty + dy };
              dirty.current = true;
            }
            return;
          }
          const p = local(e);
          useWorkspace.getState().setHover(pick(p.x, p.y));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!interactive || (d && d.moved)) return;
          const p = local(e);
          useWorkspace.getState().select(pick(p.x, p.y));
        }}
        onPointerLeave={() => useWorkspace.getState().setHover(null)}
        onDoubleClick={() => {
          userMoved.current = false;
          fit();
        }}
        onKeyDown={(e) => {
          const step = 50;
          const v = xf.current;
          if (e.key === 'ArrowLeft') xf.current = { ...v, tx: v.tx + step };
          else if (e.key === 'ArrowRight') xf.current = { ...v, tx: v.tx - step };
          else if (e.key === 'ArrowUp') xf.current = { ...v, ty: v.ty + step };
          else if (e.key === 'ArrowDown') xf.current = { ...v, ty: v.ty - step };
          else if (e.key === '0') {
            userMoved.current = false;
            fit();
            return;
          } else return;
          e.preventDefault();
          userMoved.current = true;
          dirty.current = true;
        }}
      />
    </div>
  );
}
