import { createHash } from 'node:crypto';
import type {
  AttemptRecord, Evidence, FailedTestRecord, FailureCategory, TriageResult, TriageSignal,
} from '../types.js';

/**
 * The 12-category triage decision table.
 *
 * Design: deterministic rules first, ordered by specificity. Each rule records
 * the signals it fired (supporting) and the checks that pointed elsewhere
 * (contradicting) so every classification is auditable. UNKNOWN is a real
 * outcome — the platform never guesses with false confidence.
 *
 * Rules encode the golden rules: a retry-pass does NOT wash out a regression
 * when relevant product code changed (rule 2); environment noise is separated
 * from product defects (rule 10).
 */

const ENV_ERROR_PATTERNS: RegExp[] = [
  /ECONNREFUSED/i, /ENOTFOUND/i, /ECONNRESET/i, /EAI_AGAIN/i, /ETIMEDOUT/i,
  /getaddrinfo/i, /connect EHOSTUNREACH/i, /connection refused/i, /dial tcp/i,
  /50[23] (service unavailable|bad gateway)/i, /port already in use/i, /EPERM/i, /EACCES/i,
];
const DEPENDENCY_PATTERNS: RegExp[] = [
  /Cannot find module/i, /Module not found/i, /peer dep/i, /ERR_MODULE_NOT_FOUND/i,
  /ImportError/i, /No module named/i, /ERESOLVE/i, /version conflict/i, /NoSuchMethodError/i,
];
const TIMEOUT_PATTERNS: RegExp[] = [
  /timeout/i, /timed? ?out/i, /exceeded deadline/i, /deadline exceeded/i, /deadline-exceeded/i,
  /test timeout of/i, /TimeoutError: Waiting for/i,
];
const SELECTOR_PATTERNS: RegExp[] = [
  /TimeoutError.*(locator|waitFor|waitForSelector|getBy|selector)/i,
  /waiting for (locator|selector)/i, /no element matching/i, /Unable to find element/i,
  /TestingLibraryElementError/i, /locator (click|fill|waitFor) (timeout|timed out)/i,
  /Element .* not (found|visible)/i, /stale element reference/i, /NoSuchElement/i,
];
const CONFIG_PATTERNS: RegExp[] = [
  /SyntaxError/i, /ReferenceError/i, /TypeError: (?!Cannot read propert)/i,
  /Invalid (config|option)/i, /unexpected token/i, /Failed to load (config|url)/i,
  /TypeError: (.*) is not a (function|constructor)/i,
];
const DATA_PATTERNS: RegExp[] = [
  /duplicate key value/i, /unique constraint/i, /foreign key/i, /constraint violation/i,
  /E11000 duplicate/i, /no such table/i, /no such column/i, /relation .* does not exist/i,
  /fixture/i, /test data/i, /SequelizeUniqueConstraintError/i, /IntegrityError/i,
];
const ASSERT_PATTERNS: RegExp[] = [
  /AssertionError/i, /expect(ed?)/i, /assert/i, /EvalError/i,
  /to (equal|be|contain|match|have)/i, /Expected:.*Received:/i, /toBe|toEqual|toBeCloseTo|toContain/,
];

function firstErrorType(attempts: AttemptRecord[]): string | undefined {
  for (const a of attempts) {
    if (a.status === 'failed' || a.status === 'timedout') return a.errorType;
  }
  return undefined;
}

function allMessages(attempts: AttemptRecord[]): string {
  return attempts.map((a) => `${a.errorType ?? ''} ${a.errorMessage ?? ''} ${a.errorStack ?? ''}`).join('\n');
}

function attemptsPerStatus(attempts: AttemptRecord[]): { failed: number; passed: number; timedout: number } {
  return {
    failed: attempts.filter((a) => a.status === 'failed').length,
    passed: attempts.filter((a) => a.status === 'passed').length,
    timedout: attempts.filter((a) => a.status === 'timedout').length,
  };
}

function ev(idSeed: string, kind: Evidence['kind'], summary: string, label: Evidence['label']): Evidence {
  const id = 'ev-' + createHash('sha256').update(idSeed).digest('hex').slice(0, 8);
  return { id, kind, summary, collectedAt: new Date().toISOString(), label };
}

export interface TriageContext {
  /** True when any changed file is (transitively) covered by the failing test. */
  coversChangedCode: boolean;
  /** Changed file paths relevant to this test. */
  relevantChangedFiles: string[];
  /** True when a selector/locator literal used by the test appears in the diff. */
  selectorChangedInDiff: boolean;
}

export function classifyFailure(record: FailedTestRecord, ctx: TriageContext): TriageResult {
  const attempts = record.attempts;
  const { failed, passed, timedout } = attemptsPerStatus(attempts);
  const messages = allMessages(attempts);
  const signals: TriageSignal[] = [];
  const contradicting: TriageSignal[] = [];
  const evidence: Evidence[] = [];

  const firstAttempt = attempts[0];
  const lastAttempt = attempts[attempts.length - 1];
  const retried = attempts.length > 1;
  const passAfterRetry = retried && passed > 0 && (failed > 0 || timedout > 0);
  const consistentFailure = (failed + timedout) === attempts.length && attempts.length > 0;
  const intermittentHistory = record.recentRuns.includes('passed') && record.recentRuns.includes('failed');

  if (firstAttempt) {
    evidence.push(ev(`${record.testId}:attempt1`, 'test_output',
      `first attempt ${firstAttempt.status}${firstAttempt.errorMessage ? `: ${firstAttempt.errorMessage.slice(0, 120)}` : ''}`,
      'OBSERVED'));
  }
  if (ctx.relevantChangedFiles.length > 0) {
    evidence.push(ev(`${record.testId}:diff`, 'git_diff',
      `changed files covered by this test: ${ctx.relevantChangedFiles.slice(0, 3).join(', ')}`, 'OBSERVED'));
  }
  if (record.recentRuns.length > 0) {
    const intermittent = record.recentRuns.includes('passed') && record.recentRuns.includes('failed');
    evidence.push(ev(`${record.testId}:history`, 'historical_run',
      `recent ${record.recentRuns.length} runs: ${record.recentRuns.join(',')}${intermittent ? ' (intermittent)' : ''}`, 'OBSERVED'));
  }

  // ---- Decision table (ordered by specificity) ---------------------------

  // 1. Dependency failure — module resolution / version conflicts.
  if (DEPENDENCY_PATTERNS.some((p) => p.test(messages))) {
    signals.push({ description: 'error matches module-resolution/version-conflict patterns', polarity: 'supports' });
    return verdict(record, 'DEPENDENCY_FAILURE', 0.9,
      'A dependency is missing, incompatible, or was not installed in this environment.',
      signals, contradicting, evidence,
      'Run dependency install in the failing environment; pin the dependency version; add a doctor check for this module.');
  }

  // 2. Configuration failure — syntax/type/config-load errors are deterministic.
  if (CONFIG_PATTERNS.some((p) => p.test(messages)) && !SELECTOR_PATTERNS.some((p) => p.test(messages))) {
    signals.push({ description: 'error matches syntax/config-load failure patterns', polarity: 'supports' });
    if (consistentFailure) signals.push({ description: `fails on all ${attempts.length} attempts (deterministic)`, polarity: 'supports' });
    return verdict(record, 'CONFIGURATION_FAILURE', 0.85,
      'The test (or its target) fails to load/parse — configuration or compile-time problem, not a behavioral failure.',
      signals, contradicting, evidence,
      'Fix the syntax/config error; run the suite locally in the failing environment before re-triggering CI.');
  }

  // 3. Selector failure — locator cannot find element + selector changed in diff.
  if (SELECTOR_PATTERNS.some((p) => p.test(messages))) {
    signals.push({ description: 'error is a locator/selector wait failure', polarity: 'supports' });
    if (ctx.selectorChangedInDiff) {
      signals.push({ description: 'selector literal appears in the product diff (UI was refactored)', polarity: 'supports' });
      return verdict(record, 'SELECTOR_FAILURE', 0.9,
        'The test targets a selector that the change set renamed or moved — test needs updating, product behavior likely unchanged.',
        signals, contradicting, evidence,
        'Update the test to the new selector using role/label-based locators; do not weaken the assertion (golden rule 1).');
    }
    contradicting.push({ description: 'selector literal does not appear in the product diff', polarity: 'contradicts' });
    if (passAfterRetry && !consistentFailure) {
      signals.push({ description: 'passed on retry — element eventually appeared', polarity: 'supports' });
      return verdict(record, 'TIMING_FAILURE', 0.7,
        'Element appeared late (async render/fetch) — timing-sensitive wait, not a selector defect.',
        signals, contradicting, evidence,
        'Replace fixed waits with web-first assertions on the expected state; check for slow environment (doctor).');
    }
    return verdict(record, 'SELECTOR_FAILURE', 0.6,
      'Locator cannot find the element and the selector did not change — either a product regression removed it or the test was already broken.',
      signals, contradicting, evidence,
      'Inspect the DOM in the failure evidence bundle; if the element was intentionally removed, update the test; else treat as product regression.');
  }

  // 4. Environment failure — infra noise with no product change involved.
  if (ENV_ERROR_PATTERNS.some((p) => p.test(messages))) {
    signals.push({ description: 'error matches infrastructure noise patterns (connection/refused/unavailable)', polarity: 'supports' });
    if (!ctx.coversChangedCode) {
      signals.push({ description: 'test does not cover changed code', polarity: 'supports' });
      if (record.networkVerified === false) signals.push({ description: 'network reachability check failed during run', polarity: 'supports' });
      return verdict(record, 'ENVIRONMENT_FAILURE', 0.85,
        'Infrastructure/environment failure — the service or network was unavailable; product code unchanged for this test.',
        signals, contradicting, evidence,
        'Re-run once the environment is healthy; quarantine temporarily only if recurrence blocks CI; fix the env, not the test.');
    }
    contradicting.push({ description: 'test covers changed code — env noise may mask a real regression', polarity: 'contradicts' });
    return verdict(record, 'ENVIRONMENT_FAILURE', 0.55,
      'Environment error pattern, but the test covers changed code — fix environment first, then re-run before concluding.',
      signals, contradicting, evidence,
      'Restore environment health, re-run, then re-triage; do not mark product as broken on this evidence alone.');
  }

  // 5. Network failure — network-adjacent errors while env otherwise healthy.
  if (/(fetch failed|networkerror|net::|request failed|socket hang up)/i.test(messages) && (record.networkVerified === undefined || record.networkVerified)) {
    signals.push({ description: 'network-layer error with environment otherwise reachable', polarity: 'supports' });
    return verdict(record, 'NETWORK_FAILURE', 0.7,
      'A network request inside the test failed — upstream/service issue rather than assertion logic.',
      signals, contradicting, evidence,
      'Check the service behind the request; add contract tests so failures point at the exact boundary.');
  }

  // 6. Test data defect — constraint violations / fixture problems.
  if (DATA_PATTERNS.some((p) => p.test(messages))) {
    signals.push({ description: 'error matches data-integrity/fixture patterns', polarity: 'supports' });
    return verdict(record, 'TEST_DATA_DEFECT', 0.8,
      'Test data problem: uniqueness collision, missing fixture, or schema mismatch in the data the test set up.',
      signals, contradicting, evidence,
      'Fix the factory/fixture (unique identities, deterministic seeds); do not weaken the assertion.');
  }

  // 7. Timing failure — explicit timeout without selector semantics.
  //    Exception: a timeout-shaped failure that passed on retry, covers no
  //    changed code, and has intermittent history is FLAKE, not timing —
  //    the retry outcome plus history outweighs the error's phrasing.
  if ((timedout > 0 || TIMEOUT_PATTERNS.some((p) => p.test(messages))) &&
      !(passAfterRetry && !ctx.coversChangedCode && intermittentHistory)) {
    signals.push({ description: 'failure is a timeout', polarity: 'supports' });
    if (passAfterRetry) signals.push({ description: `passed after retry (attempt ${attempts.length})`, polarity: 'supports' });
    if (ctx.coversChangedCode) contradicting.push({ description: 'test covers changed code — slowdown may be caused by the change', polarity: 'contradicts' });
    const confidence = passAfterRetry && !ctx.coversChangedCode ? 0.8 : 0.55;
    return verdict(record, 'TIMING_FAILURE', confidence,
      passAfterRetry
        ? 'Timeout resolved on retry — timing-sensitive operation under load; golden rule 3 forbids sleeps as the fix.'
        : 'Operation exceeded its deadline — measure before increasing any timeout.',
      signals, contradicting, evidence,
      'Profile the slow step; use web-first auto-waiting; only then consider an explicit, justified timeout increase.');
  }

  // 8. Flake — retry-pass, no relevant change, intermittent history.
  if (passAfterRetry && !ctx.coversChangedCode) {
    signals.push({ description: 'failed then passed on retry', polarity: 'supports' });
    signals.push({ description: 'no relevant product change covered by this test', polarity: 'supports' });
    if (intermittentHistory) signals.push({ description: 'historically intermittent on the same commit', polarity: 'supports' });
    const confidence = intermittentHistory ? 0.88 : 0.7;
    return verdict(record, 'FLAKE', confidence,
      'Intermittent failure: same commit, no relevant change, retry passes — classic nondeterminism signature.',
      signals, contradicting, evidence,
      'Record in flake registry; fix nondeterminism (isolation, waits, data collisions); never hide it via retries alone.');
  }

  // 9. Golden rule 2: retry does NOT wash out a regression.
  if (passAfterRetry && ctx.coversChangedCode) {
    signals.push({ description: 'passed on retry BUT test covers changed code', polarity: 'supports' });
    contradicting.push({ description: 'retry success does not clear a regression when product code changed', polarity: 'supports' });
    return verdict(record, 'REAL_REGRESSION', 0.75,
      'Test covers changed code and failed before retrying — treat as regression candidate despite eventual pass (golden rule 2).',
      signals, contradicting, evidence,
      'Re-run on a clean environment; if reproducible, block merge and fix the product change.');
  }

  // 10. Consistent assertion failure — regression vs test defect.
  if (consistentFailure && ASSERT_PATTERNS.some((p) => p.test(messages))) {
    signals.push({ description: `assertion-style failure on all ${attempts.length} attempts`, polarity: 'supports' });
    evidence.push(ev(`${record.testId}:repro`, 'test_output', `reproduced ${failed + timedout}/${attempts.length} attempts`, 'OBSERVED'));
    if (record.domVerified) signals.push({ description: 'DOM verified deterministic across attempts', polarity: 'supports' });
    if (ctx.coversChangedCode) {
      signals.push({ description: 'test covers changed code', polarity: 'supports' });
      return verdict(record, 'REAL_REGRESSION', 0.92,
        'Deterministic assertion failure over changed code — product regression until proven otherwise.',
        signals, contradicting, evidence,
        'Block merge; fix the product change or update the specification intentionally; convert into a minimal regression test.');
    }
    contradicting.push({ description: 'test does not cover changed code', polarity: 'contradicts' });
    return verdict(record, 'TEST_DEFECT', 0.7,
      'Deterministic assertion failure over unchanged code — the test (or its expectation) is likely stale or was always wrong.',
      signals, contradicting, evidence,
      'Verify the expectation against the current specification; fix the test, or file the defect if the behavior is wrong.');
  }

  // 11. Anything assertion-ish left over.
  if (ASSERT_PATTERNS.some((p) => p.test(messages))) {
    return verdict(record, 'ASSERTION_FAILURE', 0.5,
      'Assertion-related failure with mixed signals — evidence insufficient for a confident classification.',
      signals, contradicting, evidence,
      'Collect more evidence (trace, network, DOM snapshot) and re-run; do not auto-heal or auto-delete.');
  }

  // 12. UNKNOWN is an honest outcome.
  return verdict(record, 'UNKNOWN', 0.2,
    'Failure did not match any documented signature pattern with sufficient confidence.',
    signals, contradicting, evidence,
    'Escalate to human triage with the full evidence bundle; add a pattern here once root cause is known.');
}

function verdict(
  record: FailedTestRecord,
  category: FailureCategory,
  confidence: number,
  hypothesis: string,
  signals: TriageSignal[],
  contradicting: TriageSignal[],
  evidence: Evidence[],
  action: string,
): TriageResult {
  const label: TriageResult['label'] = confidence >= 0.8 ? 'OBSERVED' : 'INFERRED';
  return {
    testId: record.testId,
    category,
    confidence,
    rootCauseHypothesis: hypothesis,
    signals,
    contradictingSignals: contradicting,
    recommendedAction: action,
    evidence,
    label,
  };
}

export function errorTypeOf(attempts: AttemptRecord[]): string | undefined {
  return firstErrorType(attempts);
}

/** Does any selector literal from the test appear among changed symbol/paths? */
export function detectSelectorChange(testSource: string, diffText: string): boolean {
  const literals = [...testSource.matchAll(/(?:getBy(?:Role|Text|Label|TestId)|locator)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
  if (literals.length === 0) return false;
  return literals.some((lit) => diffText.includes(lit));
}
