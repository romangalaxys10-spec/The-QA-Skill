import { analyzeDiff, runGit } from '@the-qa-skill/core';
import type { TriageAgentContext } from '@the-qa-skill/agents';

/**
 * Shared triage-context construction for `triage`, `release`, and `report`.
 * A diff range becomes triage context in two parts:
 *   - `relevantChangedFiles` — changed paths that intersect each record's
 *     changedFiles (TriageAgent intersects per record);
 *   - `diffText` — the raw diff, used by core `detectSelectorChange` against
 *     the failing test file on disk.
 */
export interface TriageRunContext extends TriageAgentContext {}

export async function triageContextForRange(root: string, range: string): Promise<TriageRunContext> {
  try {
    const diff = await analyzeDiff(root, range);
    let diffText: string | undefined;
    try {
      diffText = await runGit(['diff', range], root);
    } catch {
      diffText = undefined; // selector-change detection degrades to false
    }
    return { relevantChangedFiles: diff.files.map((f) => f.path), diffText };
  } catch {
    return { relevantChangedFiles: [] }; // unreadable range → no diff context, honestly empty
  }
}
