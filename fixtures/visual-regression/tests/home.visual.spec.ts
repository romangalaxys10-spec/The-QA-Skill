import { test, expect } from '@playwright/test';
import { HERO_VIEWPORTS } from '../app/ui/hero-section';
import { openHero, SPRING_CAMPAIGN_HERO } from './helpers/viewports';

test.describe('orchardlane home hero', () => {
  for (const viewport of HERO_VIEWPORTS) {
    test(`hero renders consistently at ${viewport.name}`, async ({ page }) => {
      await openHero(page, viewport);
      await expect(page.locator('.hero-grid')).toBeVisible();
      await expect(page).toHaveScreenshot(`home-hero-${viewport.name}.png`, {
        maxDiffPixelRatio: 0.002,
        fullPage: false,
      });
    });
  }
});
