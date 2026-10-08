import { describe, it, expect } from 'vitest';
import { issueSession, SESSION_TTL_MS } from '../app/lib/session';
import { get, bearer } from './helpers/test-app';

describe('remembered-device sessions', () => {
  it('accepts a freshly issued session', () => {
    const session = issueSession('usr_82', 'dev_iphone_14');
    const res = get('/invoices', bearer(session.token));
    expect(res.status).toEqual(200);
  });

  it('keeps a remembered device session valid for the full 7 day window', () => {
    const issuedAt = Date.now();
    const session = issueSession('usr_82', 'dev_macbook_pro', issuedAt);
    const twoDaysLater = issuedAt + 2 * 24 * 60 * 60 * 1000;
    const res = get('/invoices', bearer(session.token), twoDaysLater);
    expect(res.status).toEqual(200);
  });

  it('rejects a session once the 7 day expiry has passed', () => {
    const issuedAt = Date.now();
    const session = issueSession('usr_82', 'dev_ipad_air', issuedAt);
    const afterExpiry = issuedAt + SESSION_TTL_MS + 60_000;
    const res = get('/invoices', bearer(session.token), afterExpiry);
    expect(res.status).toEqual(401);
  });
});
