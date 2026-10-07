import type { SafetyClass } from './types.js';

/**
 * Safe automation policy.
 * Every action the platform can take is classified; HIGH_RISK actions require
 * an explicit confirmation flag (`--confirm-risk` or an agent's explicit
 * approval step) before execution. Classification is conservative: anything
 * touching production, external systems, or irreversible state is HIGH_RISK.
 */

export interface ActionPolicy {
  action: string;
  safety: SafetyClass;
  /** Human explanation surfaced by `qa explain safety`. */
  rationale: string;
  /** Confirmation flag required when HIGH_RISK. */
  requiresFlag?: string;
}

const READ_ONLY = (action: string, rationale: string): ActionPolicy => ({ action, safety: 'READ_ONLY', rationale });
const LOW_RISK = (action: string, rationale: string): ActionPolicy => ({ action, safety: 'LOW_RISK_WRITE', rationale });
const HIGH_RISK = (action: string, rationale: string, flag = '--confirm-risk'): ActionPolicy => ({ action, safety: 'HIGH_RISK', rationale, requiresFlag: flag });

export const ACTION_POLICIES: readonly ActionPolicy[] = [
  READ_ONLY('discover', 'Inspects repository structure and test inventory without writing.'),
  READ_ONLY('plan', 'Produces a QA plan document in memory; writes only with --out.'),
  READ_ONLY('risk', 'Reads diffs and history; computes scores.'),
  READ_ONLY('impact', 'Reads diffs and import graph; selects tests without running them.'),
  READ_ONLY('coverage', 'Computes coverage from inventory; reads only.'),
  READ_ONLY('flake', 'Reads historical run records; reads only.'),
  READ_ONLY('report', 'Renders existing artifacts; reads only.'),
  READ_ONLY('doctor', 'Performs environment health checks; probes local ports without modifying.'),
  READ_ONLY('explain', 'Explains models, rules, and prior decisions.'),
  READ_ONLY('test', 'Executing tests does not modify tracked sources; artifacts go to untracked dirs.'),
  LOW_RISK('generate', 'Creates new test files under the generated-tests directory; never overwrites existing files without --force.'),
  LOW_RISK('init', 'Writes theqa.config.json and .theqa/ scaffolding into the target repo.'),
  LOW_RISK('heal.apply.high-tier', 'Applies only HIGH-tier healing proposals that passed every policy check; original file preserved as .bak alongside.'),
  HIGH_RISK('db.migrate', 'Destructive database operations can corrupt or destroy persistent state.'),
  HIGH_RISK('test.production', 'Running tests against production can mutate real data and trigger real side effects (emails, payments).'),
  HIGH_RISK('external.systems', 'Calls to external third-party systems may create records, spend money, or notify real users.'),
  HIGH_RISK('coverage.delete', 'Deleting coverage or baseline data destroys verification history.'),
  HIGH_RISK('ci.security.change', 'Modifying CI security configuration (permissions, secrets, runners) changes the trust boundary.'),
  HIGH_RISK('deploy', 'Deployments change what real users experience.'),
  HIGH_RISK('prod.data.write', 'Writing production data is irreversible in general.'),
  HIGH_RISK('notify.external', 'Posting to Slack/Jira/email reaches humans outside the loop.'),
  HIGH_RISK('test.delete', 'Deleting tests removes protection; requires strong recorded evidence.'),
] as const;

export function classifyAction(action: string): ActionPolicy {
  const exact = ACTION_POLICIES.find((p) => p.action === action);
  if (exact) return exact;
  // Conservative default: unknown actions that only read are READ_ONLY only if
  // they match an explicit read verb; otherwise treat as HIGH_RISK.
  if (/^(read|inspect|list|show|get|diff|check)/i.test(action)) return READ_ONLY(action, 'Unregistered read-shaped action; classified conservatively as read-only.');
  return HIGH_RISK(action, 'Unregistered action — classified HIGH_RISK until registered in ACTION_POLICIES.');
}

export function requiresConfirmation(action: string): boolean {
  return classifyAction(action).safety === 'HIGH_RISK';
}

export function assertAuthorized(action: string, opts: { confirmRisk?: boolean }): void {
  const policy = classifyAction(action);
  if (policy.safety === 'HIGH_RISK' && !opts.confirmRisk) {
    throw new Error(
      `Action "${action}" is HIGH_RISK (${policy.rationale}) ` +
      `and requires explicit confirmation via ${policy.requiresFlag ?? '--confirm-risk'}.`,
    );
  }
}
