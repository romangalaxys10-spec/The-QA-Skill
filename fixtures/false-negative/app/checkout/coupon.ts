export interface Coupon {
  code: string;
  percentOff: number;
  /** Inclusive last day on which the code redeems (ISO date). */
  expiresAt: string;
}

export interface CouponOutcome {
  code: string | null;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

const CATALOG: Record<string, Coupon> = {
  SPRING10: { code: 'SPRING10', percentOff: 10, expiresAt: '2026-06-30' },
  WELCOME15: { code: 'WELCOME15', percentOff: 15, expiresAt: '2026-12-31' },
};

/** Full-price baseline for a cart that redeems no coupon. */
export function quoteWithoutCoupon(subtotalCents: number): CouponOutcome {
  return { code: null, subtotalCents, discountCents: 0, totalCents: subtotalCents };
}

export function applyCoupon(subtotalCents: number, code: string, now = new Date()): CouponOutcome {
  const coupon = CATALOG[code.toUpperCase()];
  if (!coupon) {
    return quoteWithoutCoupon(subtotalCents);
  }
  const discountCents = Math.round((subtotalCents * coupon.percentOff) / 100);
  return { code: coupon.code, subtotalCents, discountCents, totalCents: subtotalCents - discountCents };
}
