import { requireSession, type AuthedRequest } from '../../app/http/auth-middleware';

export interface TestResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Minimal supertest-style harness: requests go through the real middleware
 * chain, so auth outcomes reflect exactly what production would return.
 */
export function get(
  path: string,
  headers: Record<string, string> = {},
  now = Date.now(),
): TestResponse {
  const req: AuthedRequest = { method: 'GET', path, headers };
  const outcome = requireSession(req, now);
  const body: Record<string, unknown> =
    outcome.userId !== undefined
      ? { userId: outcome.userId }
      : { reason: outcome.reason ?? 'public_route' };
  return { status: outcome.status, body };
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
