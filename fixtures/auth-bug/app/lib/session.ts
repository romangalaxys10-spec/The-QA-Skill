/**
 * Session lifecycle for LedgerDesk.
 *
 * Sessions are opaque tokens bound to a device record. Remembered devices
 * may keep a session alive across a rolling 7-day window, but every session
 * carries a hard lifetime so a leaked token cannot be extended forever.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const HARD_SESSION_CAP_MS = 5 * 60 * 1000; // security review cap

export interface SessionRecord {
  token: string;
  userId: string;
  deviceId: string;
  issuedAt: number;
  lastExtendedAt: number;
  expiresAt: number;
}

const store = new Map<string, SessionRecord>();

export function issueSession(userId: string, deviceId: string, now = Date.now()): SessionRecord {
  const record: SessionRecord = {
    token: `sess_${userId}_${deviceId}_${now.toString(36)}`,
    userId,
    deviceId,
    issuedAt: now,
    lastExtendedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  store.set(record.token, record);
  return record;
}

export function extendSession(token: string, now = Date.now()): SessionRecord | null {
  const record = store.get(token);
  if (!record) return null;
  record.lastExtendedAt = now;
  record.expiresAt = now + SESSION_TTL_MS;
  return record;
}

export function verifySession(token: string, now = Date.now()): SessionRecord | null {
  const record = store.get(token);
  if (!record) return null;
  // A remembered device rolls its window forward on activity, but the hard
  // lifetime always anchors to the original issue time (security review
  // SEC-114: a stolen token must not be renewable indefinitely).
  const hardDeadline = record.issuedAt + HARD_SESSION_CAP_MS;
  if (now >= hardDeadline) return null;
  if (now >= record.expiresAt) return null;
  return record;
}

export function revokeSession(token: string): void {
  store.delete(token);
}

export function sessionFor(token: string): SessionRecord | undefined {
  return store.get(token);
}
