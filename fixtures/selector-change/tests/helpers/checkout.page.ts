import type { CartLine } from '../../app/lib/cart-total';

export interface CheckoutHarness {
  open(path?: string): Promise<void>;
  submit(): Promise<void>;
  lineCount(): Promise<number>;
}

const SAMPLE_CART: CartLine[] = [
  { sku: 'SKU-LOG-2', title: 'Field logbook', quantity: 2, unitPriceCents: 1450 },
  { sku: 'SKU-PEN-9', title: 'All-weather pen', quantity: 1, unitPriceCents: 890 },
];

/**
 * Drives the checkout review panel in component and e2e runs. Line item
 * typing is imported from the product module so the harness and the panel
 * cannot drift apart silently.
 */
export class CheckoutPage implements CheckoutHarness {
  constructor(private readonly page: unknown) {}

  async open(path = '/checkout'): Promise<void> {
    const p = this.page as { goto: (url: string) => Promise<void> };
    await p.goto(`http://localhost:4173${path}`);
  }

  async submit(): Promise<void> {
    const p = this.page as {
      getByTestId: (id: string) => { click: () => Promise<void> };
    };
    await p.getByTestId('submit-order').click();
  }

  async lineCount(): Promise<number> {
    const p = this.page as {
      getByRole: (role: string, opts: object) => { count: () => Promise<number> };
    };
    return p.getByRole('listitem', {}).count();
  }

  static sampleCart(): CartLine[] {
    return SAMPLE_CART;
  }
}
