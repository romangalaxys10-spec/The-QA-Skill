import type { PaymentProcessor, CaptureRequest, CaptureResult } from './processor';

export type ScriptedFailure = 'processor_timeout' | 'connection_dropped';

/**
 * Processor stub for the charge retry specs. Scripted failures are consumed
 * in order; every capture attempt (failed or not) is recorded so specs can
 * assert exactly how much money the gateway was asked to move.
 */
export class FakeProcessor implements PaymentProcessor {
  readonly captures: CaptureRequest[] = [];
  private readonly script: ScriptedFailure[];

  constructor(script: ScriptedFailure[]) {
    this.script = [...script];
  }

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    this.captures.push(req);
    const failure = this.script.shift();
    if (failure === 'processor_timeout') {
      // The gateway captured, but the client gave up before the response
      // arrived — the classic ambiguous timeout.
      throw new Error('processor_timeout after 4000ms');
    }
    if (failure === 'connection_dropped') {
      throw new Error('connection_dropped mid-response');
    }
    return {
      captureId: `cap_${req.idempotencyKey}`,
      amountCents: req.amountCents,
      processor: 'fake',
    };
  }
}
