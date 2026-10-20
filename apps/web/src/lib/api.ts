/** Thin, typed client for the SWEEP API with CSRF handling. */
export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

const IS_STATIC = typeof __SWEEP_STATIC__ !== 'undefined' && __SWEEP_STATIC__;

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]!) : null;
}

let csrfPromise: Promise<string> | null = null;
async function csrfToken(): Promise<string> {
  const existing = readCookie('sweep_csrf');
  if (existing) return existing;
  csrfPromise ??= fetch('/api/auth/csrf', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((j: { data: { token: string } }) => j.data.token)
    .finally(() => {
      csrfPromise = null;
    });
  return csrfPromise;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  if (IS_STATIC) throw new ApiRequestError(0, 'OFFLINE', 'This build runs without a server.');
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = await csrfToken();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiRequestError(0, 'NETWORK', 'Cannot reach the SWEEP server.');
  }
  let json: { ok: boolean; data?: T; error?: { code: string; message: string; details?: unknown } } | null = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || !json?.ok) {
    if (res.status === 403 && json?.error?.code === 'CSRF_TOKEN') {
      document.cookie = 'sweep_csrf=; Max-Age=0; path=/';
    }
    throw new ApiRequestError(res.status, json?.error?.code ?? 'HTTP_ERROR', json?.error?.message ?? `Request failed (${res.status}).`, json?.error?.details);
  }
  return json.data as T;
}

let healthPromise: Promise<boolean> | null = null;
/** Whether an API server is reachable (cached for the session; static builds never have one). */
export function serverAvailable(): Promise<boolean> {
  if (IS_STATIC) return Promise.resolve(false);
  healthPromise ??= (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const r = await fetch('/api/health', { signal: ctrl.signal });
      const j = (await r.json()) as { ok?: boolean };
      return r.ok && j.ok === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  })();
  return healthPromise;
}

export const isStaticBuild = IS_STATIC;
