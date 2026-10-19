import type { CoverageRequest, CoverageResponse } from './coverage.worker';

type Pending = { resolve: (r: CoverageResponse) => void; reject: (e: Error) => void };
type Req = CoverageRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/** Promise wrapper around the coverage worker (one worker per page; plans run one after another). */
class CoverageClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private ready: Promise<void> | null = null;
  private url = '';

  init(url: string): Promise<void> {
    if (this.ready && this.url === url) return this.ready;
    this.url = url;
    this.worker?.terminate();
    this.worker = new Worker(new URL('./coverage.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<CoverageResponse>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data);
      else p.reject(new Error(ev.data.error));
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Coverage worker failed.'));
      this.pending.clear();
    };
    this.ready = this.send({ op: 'init', url }).then(() => undefined);
    return this.ready;
  }

  send<T extends CoverageResponse = CoverageResponse>(req: Req): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: CoverageResponse) => void, reject });
      this.worker!.postMessage({ ...req, id });
    });
  }
}

export const coverage = new CoverageClient();
