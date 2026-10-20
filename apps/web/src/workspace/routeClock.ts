/**
 * Playback clock for route animation. Progress lives outside React so the
 * vehicle can move every frame without re-rendering the application; React
 * components subscribe and update their DOM directly (or at a throttled rate).
 */
type Listener = (s: number) => void;

class RouteClock {
  s = 0;
  total = 0;
  playing = false;
  speed = 1;
  /** seconds to traverse the whole route at speed 1 */
  baseDuration = 24;
  private listeners = new Set<Listener>();
  private endListeners = new Set<() => void>();
  private raf = 0;
  private last = 0;

  setTotal(total: number): void {
    this.total = total;
    this.baseDuration = Math.max(10, Math.min(60, 10 + total / 400));
    if (this.s > total) this.seek(total);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.s);
    return () => this.listeners.delete(fn);
  }

  onEnd(fn: () => void): () => void {
    this.endListeners.add(fn);
    return () => this.endListeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l(this.s);
  }

  seek(s: number): void {
    this.s = Math.max(0, Math.min(this.total, s));
    this.emit();
  }

  play(): void {
    if (this.playing || this.total <= 0) return;
    if (this.s >= this.total) this.s = 0;
    this.playing = true;
    this.last = performance.now();
    const tick = (now: number): void => {
      if (!this.playing) return;
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.s = Math.min(this.total, this.s + (this.total / this.baseDuration) * this.speed * dt);
      this.emit();
      if (this.s >= this.total) {
        this.playing = false;
        for (const l of this.endListeners) l();
        return;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
  }

  reset(): void {
    this.pause();
    this.seek(0);
  }
}

export const routeClock = new RouteClock();
