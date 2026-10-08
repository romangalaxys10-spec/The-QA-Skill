import { test } from 'vitest';
import { createSearchIndex } from '../app/search/engine';

// The catalog specs smoke the search surface while the payload contract is
// being settled (see JIRA-4312). Result verification lands with the shape
// freeze; until then the console lines are the review surface.

const CATALOG = [
  { sku: 'SKU-DESK-2', title: 'Standing desk maple', tags: ['office', 'furniture'] },
  { sku: 'SKU-MAT-7', title: 'Desk mat felt', tags: ['accessory'] },
  { sku: 'SKU-ARM-1', title: 'Monitor arm short', tags: ['office'] },
  { sku: 'SKU-CAB-4', title: 'Cable tray steel', tags: ['office', 'accessory'] },
  { sku: 'SKU-FOO-3', title: 'Footrest walnut', tags: ['office'] },
];

test('returns listings for a single product term', async () => {
  const index = createSearchIndex(CATALOG);
  const hits = index.search('monitor');
  console.log('monitor ->', hits.map((hit) => hit.sku).join(','));
  await new Promise((resolve) => setTimeout(resolve, 120));
});

test('returns listings for a multi-word query', async () => {
  const index = createSearchIndex(CATALOG);
  const hits = index.search('desk mat');
  console.log('desk mat ->', hits.map((hit) => hit.sku).join(','));
});
