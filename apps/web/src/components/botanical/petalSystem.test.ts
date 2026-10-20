import { describe, expect, it } from 'vitest';
import { PetalSystem } from './petalSystem';

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a * 1664525 + 1013904223) % 4294967296;
    return a / 4294967296;
  };
}

describe('PetalSystem', () => {
  it('emits petals in proportion to distance travelled, not to event count', () => {
    const a = new PetalSystem({ maxPetals: 500, maxSparks: 0, maxBlooms: 1, spacing: 10, intensity: 1, random: seeded(1) });
    // 300 px in 3 events
    a.pointer(0, 0, 0);
    a.pointer(100, 0, 16);
    a.pointer(200, 0, 32);
    a.pointer(300, 0, 48);
    const b = new PetalSystem({ maxPetals: 500, maxSparks: 0, maxBlooms: 1, spacing: 10, intensity: 1, random: seeded(1) });
    // the same 300 px in 300 events
    for (let x = 0; x <= 300; x++) b.pointer(x, 0, x);
    expect(a.emittedTotal).toBe(30);
    expect(b.emittedTotal).toBe(30);
  });

  it('never exceeds its pool and recycles dead particles', () => {
    const s = new PetalSystem({ maxPetals: 40, maxSparks: 30, maxBlooms: 2, spacing: 4, intensity: 1, random: seeded(7) });
    for (let i = 0; i < 5000; i++) s.pointer((i * 7) % 800, (i * 13) % 600, i * 4);
    expect(s.petals.filter((p) => p.alive).length).toBeLessThanOrEqual(40);
    expect(s.sparks.filter((p) => p.alive).length).toBeLessThanOrEqual(30);
    expect(s.petals).toHaveLength(40);
    // run long enough for everything to die
    for (let t = 0; t < 400; t++) s.step(16, 20000 + t * 16);
    expect(s.aliveCount).toBe(0);
    expect(s.active).toBe(false);
  });

  it('does not spray a line when the pointer re-enters far away', () => {
    const s = new PetalSystem({ maxPetals: 100, maxSparks: 0, maxBlooms: 1, spacing: 10, intensity: 1, random: seeded(3) });
    s.pointer(0, 0, 0);
    s.pointer(1200, 900, 16);
    expect(s.emittedTotal).toBe(0);
  });

  it('respects intensity 0 and bounds blooms', () => {
    const s = new PetalSystem({ maxPetals: 100, maxSparks: 50, maxBlooms: 2, spacing: 10, intensity: 0, random: seeded(5) });
    for (let x = 0; x < 300; x++) s.pointer(x, 0, x);
    expect(s.emittedTotal).toBe(0);
    expect(s.bloom(10, 10)).toBe(true);
    expect(s.bloom(20, 20)).toBe(true);
    expect(s.bloom(30, 30)).toBe(false);
  });
});
