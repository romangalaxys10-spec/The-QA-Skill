import type { Page } from '@playwright/test';

/**
 * Page object for the PulseBoard KPI grid. The grid hydrates from the
 * metrics bundle, so on a cold CI runner the first paint can lag behind
 * the navigation event.
 */
export class KpiPage {
  constructor(private readonly page: Page) {}

  async open(path = '/dashboard'): Promise<void> {
    await this.page.goto(`http://localhost:4173${path}`);
  }

  grid() {
    return this.page.getByRole('list', { name: 'KPI overview' });
  }

  async cardCount(): Promise<number> {
    return this.grid().getByRole('listitem').count();
  }

  async metricKeys(): Promise<string[]> {
    return this.grid()
      .getByRole('listitem')
      .evaluateAll((nodes) =>
        nodes.map((n) => (n as HTMLElement).dataset.metricKey ?? ''),
      );
  }

  async revenueDelta(): Promise<string> {
    return this.page
      .getByRole('listitem')
      .filter({ hasText: 'Revenue today' })
      .getByRole('status')
      .textContent() as Promise<string>;
  }
}
