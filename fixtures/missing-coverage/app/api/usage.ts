import { createHmac } from 'node:crypto';

export interface UsageQuery {
  accountId: string;
  periodStart: string;
  periodEnd: string;
}

export interface UsageTotals {
  accountId: string;
  apiCalls: number;
  billedCents: number;
  signature: string;
}

const CENTS_PER_CALL = 4;
const SIGNING_SECRET = process.env.USAGE_SIGNING_SECRET ?? 'dev-only-usage-secret';

/**
 * Subscription usage metering endpoint logic: GET /api/usage. Accounts are
 * billed per API call over the queried period; totals are signed so the
 * billing importer can detect tampering.
 */
export function parseUsageQuery(searchParams: URLSearchParams): UsageQuery {
  const accountId = searchParams.get('accountId') ?? '';
  const periodStart = searchParams.get('periodStart') ?? '';
  const periodEnd = searchParams.get('periodEnd') ?? '';
  if (!accountId.startsWith('acc_')) {
    throw new Error('accountId must start with acc_');
  }
  if (Number.isNaN(Date.parse(periodStart)) || Number.isNaN(Date.parse(periodEnd))) {
    throw new Error('periodStart and periodEnd must be ISO dates');
  }
  return { accountId, periodStart, periodEnd };
}

export function meterUsage(callsByAccount: Map<string, number>, q: UsageQuery): UsageTotals {
  const apiCalls = callsByAccount.get(q.accountId) ?? 0;
  const billedCents = apiCalls * CENTS_PER_CALL;
  const payload = `${q.accountId}|${q.periodStart}|${q.periodEnd}|${apiCalls}`;
  const signature = createHmac('sha256', SIGNING_SECRET).update(payload).digest('hex');
  return { accountId: q.accountId, apiCalls, billedCents, signature };
}

export function handleUsageRequest(searchParams: URLSearchParams, calls: Map<string, number>): UsageTotals {
  const q = parseUsageQuery(searchParams);
  return meterUsage(calls, q);
}
