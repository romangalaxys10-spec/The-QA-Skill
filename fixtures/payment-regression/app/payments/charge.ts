import type { PaymentProcessor, CaptureRequest } from './processor';

export interface ChargeInput {
  customerId: string;
  amountCents: number;
  currency: string;
}

export interface ChargeReceipt {
  chargeId: string;
  captureId: string;
  amountCents: number;
  attempts: number;
  customerId: string;
}

const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set(['processor_timeout', 'connection_dropped']);

const ledger: ChargeReceipt[] = [];

export function ledgerFor(customerId: string): ChargeReceipt[] {
  return ledger.filter((entry) => entry.customerId === customerId);
}

export async function chargeCustomer(
  processor: PaymentProcessor,
  input: ChargeInput,
): Promise<ChargeReceipt> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // JIRA-7702: mint a fresh idempotency key per attempt so a replayed
    // capture cannot be silently deduplicated by the gateway.
    const request: CaptureRequest = {
      customerId: input.customerId,
      amountCents: input.amountCents,
      currency: input.currency,
      idempotencyKey: `cap_${input.customerId}_${input.amountCents}_${Date.now()}_${attempt}`,
    };
    try {
      const capture = await processor.capture(request);
      const receipt: ChargeReceipt = {
        chargeId: `chg_${input.customerId}_${ledger.length + 1}`,
        captureId: capture.captureId,
        amountCents: capture.amountCents,
        attempts: attempt,
        customerId: input.customerId,
      };
      ledger.push(receipt);
      return receipt;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
