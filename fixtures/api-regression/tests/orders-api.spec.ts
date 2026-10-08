import { describe, it, expect } from 'vitest';
import { handleCreateOrder } from '../app/api/orders';
import { post } from './helpers/http-test-client';

const VALID_DRAFT = {
  customerId: 'cus_881',
  currency: 'USD',
  items: [{ sku: 'SKU-1', quantity: 2, unitPriceCents: 2450 }],
};

describe('POST /api/orders', () => {
  it('creates an order for a well formed draft', () => {
    const res = post('/api/orders', VALID_DRAFT);
    expect(res.status).toEqual(201);
    expect(res.body).toHaveProperty('id');
  });

  it('rejects a draft without line items with 400', () => {
    const res = post('/api/orders', { customerId: 'cus_881', currency: 'USD', items: [] });
    expect(res.status).toEqual(400);
  });

  it('rejects a draft with a malformed customer id with 400', () => {
    const res = post('/api/orders', {
      customerId: '881',
      currency: 'USD',
      items: [{ sku: 'SKU-1', quantity: 1, unitPriceCents: 100 }],
    });
    expect(res.status).toEqual(400);
  });
});
