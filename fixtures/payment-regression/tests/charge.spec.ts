import { describe, it, expect } from 'vitest';
import { chargeCustomer, ledgerFor } from '../app/payments/charge';
import { FakeProcessor } from './helpers/fake-processor';

describe('chargeCustomer retry path', () => {
  it('captures exactly once when the first attempt times out client-side', async () => {
    const processor = new FakeProcessor(['processor_timeout']);
    const receipt = await chargeCustomer(processor, {
      customerId: 'cus_4471',
      amountCents: 4900,
      currency: 'USD',
    });
    expect(receipt.attempts).toEqual(2);
    const entries = ledgerFor('cus_4471');
    expect(entries).toHaveLength(1);
  });

  it('charges once on a clean first attempt', async () => {
    const processor = new FakeProcessor([]);
    await chargeCustomer(processor, {
      customerId: 'cus_4472',
      amountCents: 2500,
      currency: 'USD',
    });
    expect(ledgerFor('cus_4472')).toHaveLength(1);
  });

  it('throws after the attempt budget is exhausted', async () => {
    const processor = new FakeProcessor([
      'processor_timeout',
      'connection_dropped',
      'processor_timeout',
    ]);
    await expect(
      chargeCustomer(processor, { customerId: 'cus_4473', amountCents: 1500, currency: 'USD' }),
    ).rejects.toThrow('processor_timeout after 4000ms');
  });
});
