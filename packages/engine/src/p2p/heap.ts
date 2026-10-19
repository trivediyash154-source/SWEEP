/**
 * Binary min-heap of (key, id) pairs with lazy deletion: a node may be pushed
 * several times and stale entries are skipped by the caller. Ties are broken
 * by id so every search is deterministic.
 */
export class MinHeap {
  private keys: Float64Array;
  private ids: Int32Array;
  size = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(Math.max(16, capacity));
    this.ids = new Int32Array(Math.max(16, capacity));
  }

  clear(): void {
    this.size = 0;
  }

  private less(i: number, j: number): boolean {
    const a = this.keys[i]!;
    const b = this.keys[j]!;
    return a < b || (a === b && this.ids[i]! < this.ids[j]!);
  }

  private swap(i: number, j: number): void {
    const k = this.keys[i]!;
    this.keys[i] = this.keys[j]!;
    this.keys[j] = k;
    const d = this.ids[i]!;
    this.ids[i] = this.ids[j]!;
    this.ids[j] = d;
  }

  push(key: number, id: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.keys.length * 2);
      k.set(this.keys);
      this.keys = k;
      const d = new Int32Array(this.ids.length * 2);
      d.set(this.ids);
      this.ids = d;
    }
    let i = this.size++;
    this.keys[i] = key;
    this.ids[i] = id;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  /** Smallest key, or Infinity when empty. */
  topKey(): number {
    return this.size > 0 ? this.keys[0]! : Infinity;
  }

  topId(): number {
    return this.ids[0]!;
  }

  /** Remove the top entry; read topKey()/topId() first. */
  pop(): void {
    const n = --this.size;
    if (n <= 0) return;
    this.keys[0] = this.keys[n]!;
    this.ids[0] = this.ids[n]!;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(l, m)) m = l;
      if (r < n && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }
}
