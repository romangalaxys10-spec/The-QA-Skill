import { verifySession } from '../lib/session';

export interface AuthedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
}

export interface AuthOutcome {
  status: number;
  userId?: string;
  reason?: string;
}

const PUBLIC_PATHS = new Set(['/health', '/login']);

/**
 * Gate every private route behind a live session. Public paths and CORS
 * preflights pass straight through; anything else must present a bearer
 * token that verifySession still considers alive.
 */
export function requireSession(req: AuthedRequest, now = Date.now()): AuthOutcome {
  if (req.method === 'OPTIONS' || PUBLIC_PATHS.has(req.path)) {
    return { status: 200 };
  }
  const header = req.headers['authorization'] ?? '';
  const token = header.replace(/^Bearer\s+/i, '');
  const session = verifySession(token, now);
  if (!session) {
    return { status: 401, reason: 'session_expired_or_unknown' };
  }
  return { status: 200, userId: session.userId };
}
