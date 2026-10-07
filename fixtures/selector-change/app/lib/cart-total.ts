export interface CartLine {
  sku: string;
  title: string;
  quantity: number;
  unitPriceCents: number;
}

export function cartSubtotalCents(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
}

export function shippingCents(lines: CartLine[], country: string): number {
  if (lines.length === 0) return 0;
  return country === 'US' ? 599 : 1299;
}

export function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
