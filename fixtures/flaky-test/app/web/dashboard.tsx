export interface KpiCardDefinition {
  metricKey: string;
  title: string;
  format: 'currency' | 'percent' | 'count';
  signedDelta: boolean;
}

/**
 * The six exec-dashboard KPI cards. Order matters: the grid renders cards
 * in this sequence and the QA page object asserts on it.
 */
export const KPI_CARDS: KpiCardDefinition[] = [
  { metricKey: 'revenue_today', title: 'Revenue today', format: 'currency', signedDelta: true },
  { metricKey: 'active_sessions', title: 'Active sessions', format: 'count', signedDelta: true },
  { metricKey: 'checkout_conversion', title: 'Checkout conversion', format: 'percent', signedDelta: true },
  { metricKey: 'open_carts', title: 'Open carts', format: 'count', signedDelta: false },
  { metricKey: 'refund_rate', title: 'Refund rate', format: 'percent', signedDelta: true },
  { metricKey: 'support_backlog', title: 'Support backlog', format: 'count', signedDelta: true },
];

export function formatDelta(card: KpiCardDefinition, percent: number): string {
  if (!card.signedDelta) return `${percent.toFixed(1)}%`;
  const sign = percent >= 0 ? '+' : '';
  return `${sign}${percent.toFixed(1)}%`;
}
