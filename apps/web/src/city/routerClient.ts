import type { RouterRequest, RouterResponse } from './router.worker';

type Pending = { resolve: (r: RouterResponse) => void; reject: (e: Error) => void };
type Req = RouterRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/** Promise wrapper around the routing worker (one worker per page). */
class RouterClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private ready: Promise<void> | null = null;
  private url = '';

  init(url: string): Promise<void> {
    if (this.ready && this.url === url) return this.ready;
    this.url = url;
    this.worker?.terminate();
    this.worker = new Worker(new URL('./router.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<RouterResponse>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data);
      else p.reject(new Error(ev.data.error));
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Routing worker failed.'));
      this.pending.clear();
    };
    this.ready = this.send({ op: 'init', url }).then(() => undefined);
    return this.ready;
  }

  send<T extends RouterResponse = RouterResponse>(req: Req): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: RouterResponse) => void, reject });
      this.worker!.postMessage({ ...req, id });
    });
  }
}

export const router = new RouterClient();
