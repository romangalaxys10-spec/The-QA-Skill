import { describe, it, expect } from 'vitest';

/**
 * Presentational contract for the KPI grid. This spec keeps the markup
 * honest without a browser: the exported card list drives both the web
 * component and the QA page object.
 */
import { KPI_CARDS } from '../app/web/dashboard';

describe('kpi card definitions', () => {
  it('defines exactly six cards', () => {
    expect(KPI_CARDS).toHaveLength(6);
  });

  it('gives every card a stable metric key', () => {
    for (const card of KPI_CARDS) {
      expect(card.metricKey).toMatch(/^[a-z_]+$/);
    }
  });

  it('sorts revenue first for the exec view', () => {
    expect(KPI_CARDS[0]?.metricKey).toEqual('revenue_today');
  });
});
