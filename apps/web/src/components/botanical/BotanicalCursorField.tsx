import { useEffect, useRef } from 'react';
import { PetalSystem, easeOutCubic, fadeEnvelope } from './petalSystem';
import { useReducedMotion, usePrefs } from '../../state/prefs';

/**
 * Cursor-reactive cherry-blossom field.
 *
 * - One fixed <canvas> overlay with pointer-events: none (never blocks the UI).
 * - Petals are emitted per distance travelled, from a bounded pool.
 * - Petal sprites are pre-rendered once; each frame is a handful of drawImage calls.
 * - The animation loop sleeps when nothing is alive and the tab is hidden.
 * - Disabled for reduced motion and for touch-first (coarse pointer) devices.
 * - Clicking an element (or its descendants) marked data-bloom-zone, but not a
 *   control or text, unfolds a bloom.
 */
export function BotanicalCursorField({ intensity = 1 }: { intensity?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const enabled = usePrefs((s) => s.petals);
  const theme = usePrefs((s) => s.theme);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || reduced || !enabled) return;
    const coarse = window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches;
    if (coarse) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const system = new PetalSystem({ maxPetals: 150, maxSparks: 110, maxBlooms: 4, spacing: 15, intensity });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const dark = theme === 'velvet';
    const sprites = makePetalSprites(dpr, dark);
    const spark = makeSparkSprite(dpr, dark);

    const resize = (): void => {
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
    };
    resize();

    let raf = 0;
    let lastFrame = performance.now();
    let running = false;

    const frame = (now: number): void => {
      const dt = now - lastFrame;
      lastFrame = now;
      system.step(dt, now);
      draw(ctx, system, sprites, spark, dpr, now, dark);
      if (system.active && !document.hidden) raf = requestAnimationFrame(frame);
      else {
        running = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
    const wake = (): void => {
      if (running || document.hidden) return;
      running = true;
      lastFrame = performance.now();
      raf = requestAnimationFrame(frame);
    };

    // Zones scale the effect: e.g. the graph editor sets data-petal-intensity="0.2", and nothing is
    // emitted while a button is held there, so petals never compete with precise dragging.
    let zoneEl: Element | null = null;
    let zone = 1;
    const onMove = (e: PointerEvent): void => {
      if (e.pointerType === 'touch') return;
      const target = e.target as Element | null;
      if (target !== zoneEl) {
        zoneEl = target;
        const z = target?.closest?.('[data-petal-intensity]');
        zone = z ? Math.max(0, Math.min(1, Number(z.getAttribute('data-petal-intensity')) || 0)) : 1;
      }
      system.setIntensity(e.buttons !== 0 && zone < 0.5 ? 0 : intensity * zone);
      system.pointer(e.clientX, e.clientY, e.timeStamp || performance.now());
      wake();
    };
    const onLeave = (): void => system.pointerLeave();
    const onClick = (e: MouseEvent): void => {
      const target = e.target as Element | null;
      if (!target?.closest('[data-bloom-zone]')) return;
      if (target.closest('a, button, input, textarea, select, label, [role="button"], [data-no-bloom], p, h1, h2, h3, li, dd, dt')) return;
      if (window.getSelection()?.toString()) return;
      if (system.bloom(e.clientX, e.clientY)) wake();
    };
    const onVisibility = (): void => {
      if (!document.hidden && system.active) wake();
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerleave', onLeave);
    document.addEventListener('mouseleave', onLeave);
    window.addEventListener('click', onClick);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('click', onClick);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [reduced, enabled, intensity, theme]);

  if (reduced || !enabled) return null;
  return <canvas ref={canvasRef} className="botanical-field" aria-hidden="true" data-testid="botanical-field" />;
}

const PETAL_COLORS: Array<[string, string, string]> = [
  ['#e98bb0', '#f3a7c4', '#ffe3ee'],
  ['#d9739e', '#f0a1c0', '#ffd6e6'],
  ['#f3a7c4', '#ffc9dc', '#fff2f7'],
];

function petalPath(c: CanvasRenderingContext2D, s: number): void {
  // A cherry petal: rounded body with a small notch at the tip, base at origin.
  c.beginPath();
  c.moveTo(0, 0);
  c.bezierCurveTo(s * 0.62, -s * 0.12, s * 0.78, -s * 0.78, s * 0.2, -s * 1.0);
  c.quadraticCurveTo(0, -s * 0.84, -s * 0.2, -s * 1.0);
  c.bezierCurveTo(-s * 0.78, -s * 0.78, -s * 0.62, -s * 0.12, 0, 0);
  c.closePath();
}

function makePetalSprites(dpr: number, dark: boolean): HTMLCanvasElement[] {
  const S = 44;
  return PETAL_COLORS.map(([base, mid, tip]) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = Math.ceil(S * dpr);
    const c = cv.getContext('2d')!;
    c.scale(dpr, dpr);
    c.translate(S / 2, S * 0.92);
    const g = c.createLinearGradient(0, 0, 0, -S * 0.82);
    g.addColorStop(0, base);
    g.addColorStop(0.45, mid);
    g.addColorStop(1, tip);
    petalPath(c, S * 0.82);
    c.fillStyle = g;
    c.shadowColor = dark ? 'rgba(243,167,196,0.55)' : 'rgba(200,90,130,0.25)';
    c.shadowBlur = dark ? 8 : 4;
    c.fill();
    c.shadowBlur = 0;
    // vein
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.lineWidth = 0.8;
    c.beginPath();
    c.moveTo(0, -2);
    c.quadraticCurveTo(S * 0.04, -S * 0.4, 0, -S * 0.7);
    c.stroke();
    return cv;
  });
}

function makeSparkSprite(dpr: number, dark: boolean): HTMLCanvasElement {
  const S = 24;
  const cv = document.createElement('canvas');
  cv.width = cv.height = Math.ceil(S * dpr);
  const c = cv.getContext('2d')!;
  c.scale(dpr, dpr);
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, dark ? 'rgba(255,248,236,1)' : 'rgba(255,255,255,1)');
  g.addColorStop(0.25, dark ? 'rgba(244,220,171,0.85)' : 'rgba(217,115,158,0.7)');
  g.addColorStop(1, 'rgba(243,167,196,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  return cv;
}

function draw(
  ctx: CanvasRenderingContext2D,
  sys: PetalSystem,
  sprites: HTMLCanvasElement[],
  spark: HTMLCanvasElement,
  dpr: number,
  now: number,
  dark: boolean,
): void {
  const { width, height } = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Ribbon: a soft, tapering, iridescent trail through recent pointer points.
  const tr = sys.trail;
  if (tr.length > 2) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < tr.length - 1; i++) {
      const a = tr[i - 1]!;
      const b = tr[i]!;
      const c = tr[i + 1]!;
      const age = (now - b.t) / 520;
      const alpha = Math.max(0, 1 - age) * (i / tr.length);
      if (alpha <= 0.01) continue;
      const hue = 330 + Math.sin(now / 900 + i * 0.25) * 25;
      ctx.strokeStyle = dark ? `hsla(${hue}, 85%, 82%, ${alpha * 0.5})` : `hsla(${hue}, 60%, 62%, ${alpha * 0.45})`;
      ctx.lineWidth = 1 + (i / tr.length) * 5;
      ctx.beginPath();
      ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.quadraticCurveTo(b.x, b.y, (b.x + c.x) / 2, (b.y + c.y) / 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Blooms (behind loose petals).
  for (const b of sys.blooms) {
    if (!b.alive) continue;
    const u = b.age / b.duration;
    const open = easeOutCubic(Math.min(1, u / 0.45));
    const fade = u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4;
    ctx.save();
    ctx.translate(b.x, b.y);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 70 * b.scale);
    glow.addColorStop(0, dark ? `rgba(243,167,196,${0.35 * fade})` : `rgba(243,167,196,${0.3 * fade})`);
    glow.addColorStop(1, 'rgba(243,167,196,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, 70 * b.scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(b.rot + u * 0.6);
    ctx.globalAlpha = fade;
    for (let layer = 0; layer < 2; layer++) {
      const sc = (layer === 0 ? 1 : 0.62) * open * b.scale;
      for (let i = 0; i < b.petals; i++) {
        ctx.save();
        ctx.rotate((i / b.petals) * Math.PI * 2 + layer * (Math.PI / b.petals));
        ctx.scale(sc, sc);
        const sp = sprites[(i + layer) % sprites.length]!;
        ctx.drawImage(sp, -sp.width / dpr / 2, -sp.height / dpr * 0.92, sp.width / dpr, sp.height / dpr);
        ctx.restore();
      }
    }
    ctx.fillStyle = dark ? '#f4dcab' : '#c58b2a';
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 6 * open, Math.sin(a) * 6 * open, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Petals.
  for (const p of sys.petals) {
    if (!p.alive) continue;
    const alpha = fadeEnvelope(p.life, p.maxLife);
    if (alpha <= 0.01) continue;
    const sp = sprites[p.variant]!;
    const w = sp.width / dpr;
    const h = sp.height / dpr;
    const scale = p.size / 32;
    ctx.save();
    ctx.globalAlpha = alpha * 0.92;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.scale(scale * (0.35 + 0.65 * Math.abs(Math.cos(p.flip))), scale);
    ctx.drawImage(sp, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  // Sparks.
  ctx.save();
  if (dark) ctx.globalCompositeOperation = 'lighter';
  for (const s of sys.sparks) {
    if (!s.alive) continue;
    const alpha = 1 - s.life / s.maxLife;
    const size = s.size * 6;
    ctx.globalAlpha = alpha * 0.9;
    ctx.drawImage(spark, s.x - size / 2, s.y - size / 2, size, size);
  }
  ctx.restore();
}
