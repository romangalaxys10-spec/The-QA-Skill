export interface RateTier {
  minUnits: number;
  unitPriceCents: number;
}

export interface RateCard {
  tiers: RateTier[];
  setupCents: number;
}

/**
 * Published rate card for DeskPass volume licensing. Tiers are inclusive:
 * an order of exactly N units prices every unit at tier N's rate.
 */
export const DEFAULT_RATE_CARD: RateCard = {
  tiers: [
    { minUnits: 1, unitPriceCents: 450 },
    { minUnits: 10, unitPriceCents: 400 },
    { minUnits: 50, unitPriceCents: 345 },
  ],
  setupCents: 1200,
};

export function unitPriceFor(units: number, card: RateCard = DEFAULT_RATE_CARD): number {
  const descending = [...card.tiers].reverse();
  const tier = descending.find((candidate) => units > candidate.minUnits) ?? card.tiers[0];
  return tier.unitPriceCents;
}

export function quoteTotal(units: number, card: RateCard = DEFAULT_RATE_CARD): number {
  return card.setupCents + units * unitPriceFor(units, card);
}
