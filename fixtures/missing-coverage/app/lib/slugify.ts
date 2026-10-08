/**
 * Slug generator for exported report filenames. Exported by the report
 * pipeline and covered by unit specs — the other, newer API module in this
 * service has no specs reaching it at all.
 */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
