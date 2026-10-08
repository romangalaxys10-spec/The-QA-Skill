import type { QualityDimensionId } from '../types.js';

/** The 17 quality dimensions with weights (sum = 100). */
export const QUALITY_DIMENSIONS: ReadonlyArray<{ id: QualityDimensionId; weight: number; description: string }> = [
  { id: 'correctness', weight: 10, description: 'Test asserts the actual intended behavior (not implementation details).' },
  { id: 'determinism', weight: 9, description: 'No arbitrary sleeps, no reliance on wall-clock or random without seeds.' },
  { id: 'isolation', weight: 8, description: 'Test sets up its own state; no ordering dependencies; parallel-safe.' },
  { id: 'assertionStrength', weight: 10, description: 'Assertions verify outcomes precisely; no tautologies.' },
  { id: 'behaviorCoverage', weight: 7, description: 'Covers observable behavior, not private internals.' },
  { id: 'negativeCoverage', weight: 7, description: 'Covers failure paths: invalid input, denied access, error responses.' },
  { id: 'boundaryCoverage', weight: 6, description: 'Zero/one/max/min/empty/null/duplicate/expired/malformed cases.' },
  { id: 'maintainability', weight: 5, description: 'Reasonable size, clear names, helpers extracted, no copy-paste walls.' },
  { id: 'readability', weight: 4, description: 'Arrange-Act-Assert readable; intent evident from names.' },
  { id: 'runtime', weight: 5, description: 'Efficient: no needless waits; appropriate layer.' },
  { id: 'duplication', weight: 4, description: 'No near-duplicate tests covering identical behavior.' },
  { id: 'mockQuality', weight: 5, description: 'Mocks match real contracts; not over-mocked; restored after test.' },
  { id: 'dataQuality', weight: 5, description: 'Factories/seeds; unique identities; no shared mutable fixtures.' },
  { id: 'security', weight: 5, description: 'No hardcoded secrets; no prod credentials; no sensitive logging.' },
  { id: 'accessibility', weight: 3, description: 'Uses accessible queries (role/label) where UI is involved.' },
  { id: 'observability', weight: 4, description: 'Failures produce useful evidence; no swallowed errors.' },
  { id: 'evidenceQuality', weight: 3, description: 'Failure messages carry context for triage.' },
] as const;

export const DIMENSION_BY_ID = new Map(QUALITY_DIMENSIONS.map((d) => [d.id, d]));
