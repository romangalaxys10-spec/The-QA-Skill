import { tokenize } from './tokenizer';

export interface SearchHit {
  sku: string;
  title: string;
  score: number;
}

export interface CatalogEntry {
  sku: string;
  title: string;
  tags: string[];
}

const SYNONYMS: Record<string, string[]> = {
  desk: ['table', 'station'],
  mat: ['rug', 'pad'],
};

/**
 * Inverted-index catalog search for FindIt. Multi-word queries intersect
 * the per-term postings after synonym expansion so "desk mat" also reaches
 * "table rug" listings.
 */
export function createSearchIndex(catalog: CatalogEntry[]) {
  const postings = new Map<string, Set<string>>();
  const bySku = new Map<string, CatalogEntry>();
  for (const entry of catalog) {
    bySku.set(entry.sku, entry);
    const terms = tokenize(`${entry.title} ${entry.tags.join(' ')}`);
    for (const term of terms) {
      const bucket = postings.get(term) ?? new Set<string>();
      bucket.add(entry.sku);
      postings.set(term, bucket);
    }
  }

  function search(query: string): SearchHit[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const expanded = terms.flatMap((term) => [term, ...(SYNONYMS[term] ?? [])]);
    let skus: Set<string> | undefined;
    for (const term of expanded) {
      const bucket = postings.get(term);
      if (!bucket) return [];
      skus = skus === undefined ? new Set(bucket) : new Set([...skus].filter((sku) => bucket.has(sku)));
    }
    const hits = [...(skus ?? [])].map((sku) => {
      const entry = bySku.get(sku);
      const titleTerms = entry ? tokenize(`${entry.title} ${entry.tags.join(' ')}`) : [];
      const score = terms.reduce((acc, term) => acc + (titleTerms.includes(term) ? 1 : 0), 0);
      return { sku, title: entry?.title ?? '', score };
    });
    return hits.sort((a, b) => b.score - a.score || a.sku.localeCompare(b.sku));
  }

  return { search };
}
