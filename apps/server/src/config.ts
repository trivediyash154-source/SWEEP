import { existsSync } from 'node:fs';

export interface ServerConfig {
  port: number;
  host: string;
  dbPath: string;
  /** Directory of the built web app to serve (optional). */
  staticDir: string | null;
  /** Set the Secure flag on cookies. Defaults to true in production. */
  secureCookies: boolean;
  /** Trust X-Forwarded-For for client IPs (only behind a trusted proxy). */
  trustProxy: boolean;
  /** Run optimisations in a worker thread with a hard timeout. */
  solverMode: 'worker' | 'inline';
  solverTimeoutMs: number;
  sessionTtlMs: number;
  /** Disable rate limiting (tests only). */
  rateLimit: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === 'production';
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.SWEEP_DB_PATH ?? 'data/sweep.db',
    // Serve the built web app automatically when it exists next to the server (pnpm start).
    staticDir: env.SWEEP_STATIC_DIR ?? (existsSync('apps/web/dist/index.html') ? 'apps/web/dist' : null),
    secureCookies: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : production,
    trustProxy: env.TRUST_PROXY === 'true',
    solverMode: env.SWEEP_SOLVER_MODE === 'inline' ? 'inline' : 'worker',
    solverTimeoutMs: Number(env.SWEEP_SOLVER_TIMEOUT_MS ?? 20_000),
    sessionTtlMs: Number(env.SWEEP_SESSION_TTL_MS ?? 7 * 24 * 3600 * 1000),
    rateLimit: env.SWEEP_RATE_LIMIT !== 'off',
  };
}
