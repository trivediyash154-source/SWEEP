import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { ApiError } from './http.js';

const scrypt = (password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));

/** scrypt parameters: N = 2^15, r = 8, p = 1 (≈32 MiB per hash). */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A fixed dummy hash so that unknown-email logins cost the same as real ones. */
let dummyHash: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(18).toString('base64'));
  return dummyHash;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export const SESSION_COOKIE = 'sweep_session';
export const CSRF_COOKIE = 'sweep_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Double-submit CSRF protection for every state-changing /api request:
 * the X-CSRF-Token header must equal the sweep_csrf cookie, and if an Origin
 * header is present it must match the request host. Combined with
 * SameSite=Lax session cookies.
 */
export const csrfProtection: MiddlewareHandler = async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const origin = c.req.header('origin');
  if (origin) {
    const host = c.req.header('host');
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = '';
    }
    if (!host || originHost !== host) throw new ApiError(403, 'CSRF_ORIGIN', 'Cross-origin request rejected.');
  }
  const cookie = getCookie(c, CSRF_COOKIE);
  const header = c.req.header(CSRF_HEADER);
  if (!cookie || !header || cookie.length !== header.length || !timingSafeEqual(Buffer.from(cookie), Buffer.from(header))) {
    throw new ApiError(403, 'CSRF_TOKEN', 'Missing or invalid CSRF token. Reload the page and try again.');
  }
  return next();
};

/** Fixed-window in-memory rate limiter (single instance). */
export function rateLimiter(opts: { windowMs: number; max: number; key: string; enabled: boolean; clientIp: (c: Parameters<MiddlewareHandler>[0]) => string }): MiddlewareHandler {
  const hits = new Map<string, { count: number; reset: number }>();
  return async (c, next) => {
    if (!opts.enabled) return next();
    const now = Date.now();
    const id = `${opts.key}:${opts.clientIp(c)}`;
    let entry = hits.get(id);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + opts.windowMs };
      hits.set(id, entry);
      if (hits.size > 50_000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
    }
    entry.count++;
    if (entry.count > opts.max) {
      c.header('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment and try again.');
    }
    return next();
  };
}
