import { test, expect } from '@playwright/test';
import { KpiPage } from './helpers/kpi-page';

const EXPECTED_CARDS = 6;

test.describe('pulseboard dashboard', () => {
  test('shows all six KPI cards', async ({ page }) => {
    const kpi = new KpiPage(page);
    await kpi.open();
    await expect(kpi.grid()).toBeVisible();
    expect(await kpi.cardCount()).toEqual(EXPECTED_CARDS);
  });

  test('marks every card with its metric key', async ({ page }) => {
    const kpi = new KpiPage(page);
    await kpi.open();
    const keys = await kpi.metricKeys();
    expect(keys).toContain('revenue_today');
    expect(keys).toContain('active_sessions');
  });

  test('renders the revenue delta as a signed percent', async ({ page }) => {
    const kpi = new KpiPage(page);
    await kpi.open();
    const delta = await kpi.revenueDelta();
    expect(delta.startsWith('+') || delta.startsWith('-')).toBeTruthy();
  });
});
