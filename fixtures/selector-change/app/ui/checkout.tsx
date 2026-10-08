import { cartSubtotalCents, shippingCents, formatMoney, type CartLine } from '../lib/cart-total';

export interface CheckoutPanelProps {
  lines: CartLine[];
  country: string;
  onPlaceOrder?: () => void;
}

/**
 * Order review panel: line items, totals, and the primary checkout CTA.
 * The submit control is the single most targeted element in the flow, so
 * its test id is treated as a public contract by the checkout specs.
 */
export function CheckoutPanel({ lines, country, onPlaceOrder }: CheckoutPanelProps) {
  const subtotal = cartSubtotalCents(lines);
  const shipping = shippingCents(lines, country);
  const total = subtotal + shipping;

  return (
    <section className="checkout-panel" aria-label="Order review">
      <ul className="checkout-lines">
        {lines.map((line) => (
          <li key={line.sku} className="checkout-line">
            <span>{line.title}</span>
            <span>×{line.quantity}</span>
            <span>{formatMoney(line.quantity * line.unitPriceCents)}</span>
          </li>
        ))}
      </ul>
      <dl className="checkout-totals">
        <div>
          <dt>Subtotal</dt>
          <dd>{formatMoney(subtotal)}</dd>
        </div>
        <div>
          <dt>Shipping</dt>
          <dd>{formatMoney(shipping)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>{formatMoney(total)}</dd>
        </div>
      </dl>
      <button type="button" data-testid="place-order" className="checkout-submit" onClick={onPlaceOrder}>
        Place order
      </button>
    </section>
  );
}
