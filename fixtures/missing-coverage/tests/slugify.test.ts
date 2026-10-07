import { describe, it, expect } from 'vitest';
import { slugify } from '../app/lib/slugify';

describe('slugify', () => {
  it('lowercases and dashes a report title', () => {
    expect(slugify('Quarterly Field Report')).toEqual('quarterly-field-report');
  });

  it('strips punctuation that is unsafe in export filenames', () => {
    expect(slugify('Q1/2026: yield & loss')).toEqual('q1-2026-yield-loss');
  });

  it('collapses runs of separators into a single dash', () => {
    expect(slugify('  spaced   out  ')).toEqual('spaced-out');
  });
});
