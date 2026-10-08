import { test, expect } from '@playwright/test';
import { openSettingsViaKeyboard } from './helpers/a11y-harness';

test.describe('nimbusdesk settings surfaces', () => {
  test('opens the settings panel from the header icon button', async ({ page }) => {
    await openSettingsViaKeyboard(page);
    await page.getByLabel('Open settings').click();
    await expect(page.getByRole('dialog', { name: 'Workspace settings' })).toBeVisible();
  });

  test('announces the gear control by its accessible name', async ({ page }) => {
    await page.goto('http://localhost:4173/settings');
    const gear = page.getByRole('button', { name: 'Open settings' });
    await expect(gear).toBeVisible();
  });
});
