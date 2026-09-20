/**
 * Protection for a local, single-user service. The threat is not a remote attacker (the
 * server binds to loopback) but a web page in the user's own browser quietly sending
 * requests to http://localhost, or a DNS-rebinding page pretending to be it.
 *
 *   1. Host check      the Host header must be a loopback name on our port (DNS rebinding)
 *   2. Origin check    a request that names an Origin must name one of ours (cross-site)
 *   3. Session token   every state-changing or agent-launching request must carry a token
 *                      that only a same-origin page can obtain. A custom header also forces
 *                      a CORS preflight, which we never approve, so other sites cannot
 *                      even send it.
 *
 * There are no CORS headers anywhere: other origins cannot read our responses.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { MiddlewareHandler } from 'hono';
import type { ApiErrorDto } from '../api-types';

export const TOKEN_HEADER = 'x-idea-synth-token';

export interface SecurityConfig {
  token: string;
  /** host[:port] values accepted in the Host header. */
  allowedHosts: string[];
  /** Origins allowed to call us (the API's own origin and the Vite dev server). */
  allowedOrigins: string[];
}

/** A per-installation token, kept in a user-only file next to the database. */
export function loadOrCreateToken(file: string): string {
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

export function localSecurity(
  token: string,
  port: number,
  devPorts: number[] = [5173],
): SecurityConfig {
  const names = ['localhost', '127.0.0.1', '[::1]'];
  const ports = [port, ...devPorts];
  return {
    token,
    allowedHosts: names.flatMap((n) => ports.map((p) => `${n}:${p}`)),
    allowedOrigins: names.flatMap((n) => ports.map((p) => `http://${n}:${p}`)),
  };
}

const deny = (code: string, message: string): ApiErrorDto => ({ error: { code, message } });

function sameToken(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function guard(config: SecurityConfig): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host')?.toLowerCase();
    if (!host || !config.allowedHosts.includes(host))
      return c.json(
        deny('forbidden', 'This service only answers on its own loopback address.'),
        403,
      );

    const origin = c.req.header('origin');
    if (origin && !config.allowedOrigins.includes(origin.toLowerCase()))
      return c.json(deny('forbidden', 'Requests from other sites are not accepted.'), 403);
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none')
      return c.json(deny('forbidden', 'Cross-site requests are not accepted.'), 403);

    const safe = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (!safe && !sameToken(c.req.header(TOKEN_HEADER), config.token))
      return c.json(deny('unauthorized', 'Missing or wrong session token.'), 401);
    return next();
  };
}
