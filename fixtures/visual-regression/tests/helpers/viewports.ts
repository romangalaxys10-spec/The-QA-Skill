import type { Page } from '@playwright/test';
import type { HeroViewport } from '../../app/ui/hero-section';

export const SPRING_CAMPAIGN_HERO = {
  copy: {
    eyebrow: 'Spring harvest',
    headline: 'Cider apples, picked at dawn',
    body: 'Single-orchard juices pressed the same week they are picked.',
    ctaLabel: 'Shop the harvest',
  },
  visual: { src: '/img/hero-spring.png', alt: 'Crates of cider apples' },
};

export async function openHero(page: Page, viewport: HeroViewport): Promise<void> {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto('http://localhost:4173/');
  await page.evaluate(() => document.fonts.ready);
}
