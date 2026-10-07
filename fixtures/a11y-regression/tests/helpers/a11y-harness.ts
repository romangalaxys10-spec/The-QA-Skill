import type { Page } from '@playwright/test';
import type { SettingsHeaderProps } from '../../app/web/settings-page';

/**
 * Shared keyboard/a11y harness for NimbusDesk specs. It mirrors the product
 * contract that the settings header keeps a keyboard-reachable open action,
 * and documents the header prop surface it relies on.
 */
export function settingsOpenHandler(props: SettingsHeaderProps): () => void {
  return props.onOpenSettings;
}

export async function openSettingsViaKeyboard(page: Page): Promise<void> {
  await page.goto('http://localhost:4173/settings');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
}
