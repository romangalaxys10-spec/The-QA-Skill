import { test, expect } from '@playwright/test';
import { CheckoutPage } from './helpers/checkout.page';

test.describe('cratecart checkout review', () => {
  test('places an order from the review panel', async ({ page }) => {
    const checkout = new CheckoutPage(page);
    await checkout.open();
    expect(await checkout.lineCount()).toEqual(2);
    await page.getByTestId('submit-order').click();
    await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible();
  });

  test('keeps the submit control enabled for a stocked cart', async ({ page }) => {
    const checkout = new CheckoutPage(page);
    await checkout.open();
    const submit = page.getByTestId('submit-order');
    await expect(submit).toBeEnabled();
  });
});
