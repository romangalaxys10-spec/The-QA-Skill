export interface CaptureRequest {
  customerId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
}

export interface CaptureResult {
  captureId: string;
  amountCents: number;
  processor: string;
}

export interface PaymentProcessor {
  capture(req: CaptureRequest): Promise<CaptureResult>;
}

export class ProcessorTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessorTimeoutError';
  }
}

/**
 * Gateway adapter for the primary card processor. The gateway itself
 * deduplicates captures by idempotency key — callers must reuse one key
 * per logical charge, including across retries.
 */
export class CardGateway implements PaymentProcessor {
  constructor(private readonly callLog: CaptureRequest[] = []) {}

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    this.callLog.push(req);
    return {
      captureId: `cap_${req.idempotencyKey}`,
      amountCents: req.amountCents,
      processor: 'cardgateway',
    };
  }

  captures(): CaptureRequest[] {
    return this.callLog;
  }
}
