/**
 * Pure, renderer-agnostic particle simulation for the botanical cursor field.
 * Kept separate from the canvas component so it can be unit-tested
 * deterministically (bounded pool, distance-based emission, lifetimes).
 */

export interface Petal {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  flip: number;
  vflip: number;
  size: number;
  life: number;
  maxLife: number;
  variant: number;
}

export interface Spark {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  life: number;
  maxLife: number;
}

export interface BloomFx {
  alive: boolean;
  x: number;
  y: number;
  age: number;
  duration: number;
  petals: number;
  rot: number;
  scale: number;
}

export interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

export interface PetalSystemOptions {
  maxPetals: number;
  maxSparks: number;
  maxBlooms: number;
  /** pixels of pointer travel per emitted petal at intensity 1 */
  spacing: number;
  intensity: number;
  random?: () => number;
}

export class PetalSystem {
  readonly petals: Petal[];
  readonly sparks: Spark[];
  readonly blooms: BloomFx[];
  readonly trail: TrailPoint[] = [];
  private carry = 0;
  private last: { x: number; y: number; t: number } | null = null;
  private time = 0;
  private rnd: () => number;
  emittedTotal = 0;

  constructor(private opts: PetalSystemOptions) {
    this.rnd = opts.random ?? Math.random;
    this.petals = Array.from({ length: opts.maxPetals }, () => ({ alive: false, x: 0, y: 0, vx: 0, vy: 0, rot: 0, vr: 0, flip: 0, vflip: 0, size: 0, life: 0, maxLife: 1, variant: 0 }));
    this.sparks = Array.from({ length: opts.maxSparks }, () => ({ alive: false, x: 0, y: 0, vx: 0, vy: 0, size: 0, life: 0, maxLife: 1 }));
    this.blooms = Array.from({ length: opts.maxBlooms }, () => ({ alive: false, x: 0, y: 0, age: 0, duration: 1, petals: 5, rot: 0, scale: 1 }));
  }

  setIntensity(intensity: number): void {
    this.opts.intensity = Math.max(0, Math.min(1, intensity));
  }

  get aliveCount(): number {
    let n = 0;
    for (const p of this.petals) if (p.alive) n++;
    for (const s of this.sparks) if (s.alive) n++;
    for (const b of this.blooms) if (b.alive) n++;
    return n;
  }

  get active(): boolean {
    return this.aliveCount > 0 || this.trail.length > 0;
  }

  /** Record pointer movement; emits petals proportional to distance travelled. */
  pointer(x: number, y: number, t: number): void {
    const prev = this.last;
    this.last = { x, y, t };
    this.trail.push({ x, y, t });
    if (this.trail.length > 28) this.trail.shift();
    if (!prev || this.opts.intensity <= 0) return;
    const dx = x - prev.x;
    const dy = y - prev.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 400) return; // pointer re-entered the window; do not spray a line
    const dt = Math.max(1, t - prev.t);
    const speed = dist / dt; // px per ms
    const spacing = this.opts.spacing / Math.max(0.15, this.opts.intensity);
    this.carry += dist;
    while (this.carry >= spacing) {
      this.carry -= spacing;
      const f = dist > 0 ? 1 - this.carry / dist : 1;
      this.emitPetal(prev.x + dx * f, prev.y + dy * f, dx / dt, dy / dt, speed);
      if (this.rnd() < 0.55) this.emitSpark(prev.x + dx * f, prev.y + dy * f, speed);
    }
  }

  pointerLeave(): void {
    this.last = null;
  }

  private emitPetal(x: number, y: number, pvx: number, pvy: number, speed: number): void {
    const p = this.petals.find((q) => !q.alive);
    if (!p) return;
    const r = this.rnd;
    const spread = 0.35 + Math.min(1.6, speed * 0.9);
    p.alive = true;
    p.x = x + (r() - 0.5) * 10;
    p.y = y + (r() - 0.5) * 10;
    p.vx = pvx * 6 + (r() - 0.5) * spread * 1.6;
    p.vy = pvy * 6 + (r() - 0.5) * spread * 1.6 - 0.25;
    p.rot = r() * Math.PI * 2;
    p.vr = (r() - 0.5) * 0.08;
    p.flip = r() * Math.PI * 2;
    p.vflip = 0.03 + r() * 0.06;
    p.size = 7 + r() * 9 + Math.min(6, speed * 4);
    p.life = 0;
    p.maxLife = 1500 + r() * 1600;
    p.variant = Math.floor(r() * 3);
    this.emittedTotal++;
  }

  private emitSpark(x: number, y: number, speed: number): void {
    const s = this.sparks.find((q) => !q.alive);
    if (!s) return;
    const r = this.rnd;
    const a = r() * Math.PI * 2;
    const v = 0.2 + r() * (0.6 + Math.min(1.2, speed));
    s.alive = true;
    s.x = x;
    s.y = y;
    s.vx = Math.cos(a) * v;
    s.vy = Math.sin(a) * v - 0.15;
    s.size = 1 + r() * 2.2;
    s.life = 0;
    s.maxLife = 500 + r() * 700;
  }

  /** Trigger a decorative bloom. Returns false if all bloom slots are busy. */
  bloom(x: number, y: number): boolean {
    const b = this.blooms.find((q) => !q.alive);
    if (!b) return false;
    b.alive = true;
    b.x = x;
    b.y = y;
    b.age = 0;
    b.duration = 1900;
    b.petals = 5;
    b.rot = this.rnd() * Math.PI * 2;
    b.scale = 0.9 + this.rnd() * 0.5;
    for (let i = 0; i < 10; i++) this.emitSpark(x, y, 0.8);
    return true;
  }

  /** Advance the simulation by dt milliseconds. */
  step(dtMs: number, now: number): void {
    const dt = Math.min(48, Math.max(0, dtMs));
    const k = dt / 16.67;
    this.time += dt;
    const t = this.time / 1000;
    for (const p of this.petals) {
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.maxLife) {
        p.alive = false;
        continue;
      }
      const wind = Math.sin(t * 0.7 + p.y * 0.008) * 0.035 + 0.012;
      p.vx = (p.vx + wind * k) * Math.pow(0.975, k);
      p.vy = (p.vy + 0.014 * k) * Math.pow(0.975, k);
      p.x += (p.vx + Math.sin(p.flip) * 0.35) * k;
      p.y += p.vy * k;
      p.rot += p.vr * k;
      p.flip += p.vflip * k;
    }
    for (const s of this.sparks) {
      if (!s.alive) continue;
      s.life += dt;
      if (s.life >= s.maxLife) {
        s.alive = false;
        continue;
      }
      s.vx *= Math.pow(0.96, k);
      s.vy = (s.vy - 0.004 * k) * Math.pow(0.96, k);
      s.x += s.vx * k;
      s.y += s.vy * k;
    }
    for (const b of this.blooms) {
      if (!b.alive) continue;
      b.age += dt;
      if (b.age >= b.duration) b.alive = false;
    }
    while (this.trail.length > 0 && now - this.trail[0]!.t > 520) this.trail.shift();
  }
}

/** Ease helpers shared by the renderer. */
export const easeOutCubic = (x: number): number => 1 - Math.pow(1 - x, 3);
export const fadeEnvelope = (life: number, maxLife: number): number => {
  const u = life / maxLife;
  return Math.min(1, u / 0.12) * (1 - Math.pow(u, 2.2));
};
