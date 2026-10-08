const STOP_TERMS = new Set(['the', 'a', 'an', 'for', 'and', 'or', 'of']);

/**
 * Splits a catalog query into index terms: lowercase alphanumerics with
 * stop terms and single characters removed.
 */
export function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1 && !STOP_TERMS.has(term));
}
