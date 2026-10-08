export interface OrderItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface OrderDraft {
  customerId: string;
  currency: string;
  items: OrderItem[];
  notes?: string;
}

export interface ValidationResult {
  ok: boolean;
  problems: string[];
}

const SKU_RE = /^SKU-[A-Z0-9-]+$/;
const CURRENCIES = new Set(['USD', 'EUR', 'GBP']);

export function validateOrderDraft(draft: Partial<OrderDraft> | undefined | null): ValidationResult {
  const problems: string[] = [];
  if (!draft) {
    problems.push('request body is required');
    return { ok: false, problems };
  }
  if (typeof draft.customerId !== 'string' || !draft.customerId.startsWith('cus_')) {
    problems.push('customerId must be a string starting with cus_');
  }
  if (typeof draft.currency !== 'string' || !CURRENCIES.has(draft.currency)) {
    problems.push('currency must be one of USD, EUR, GBP');
  }
  if (!Array.isArray(draft.items) || draft.items.length === 0) {
    problems.push('at least one line item is required');
    return { ok: problems.length === 0, problems };
  }
  draft.items.forEach((item, index) => {
    if (!item || typeof item.sku !== 'string' || !SKU_RE.test(item.sku)) {
      problems.push(`item ${index}: sku must match SKU-<alnum>`); 
    }
    if (!item || !Number.isInteger(item.quantity) || item.quantity < 1) {
      problems.push(`item ${index}: quantity must be a positive integer`);
    }
    if (!item || !Number.isInteger(item.unitPriceCents) || item.unitPriceCents <= 0) {
      problems.push(`item ${index}: unitPriceCents must be a positive integer`);
    }
  });
  return { ok: problems.length === 0, problems };
}
