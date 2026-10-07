---
name: qa-requirements
description: Extracts testable requirements and acceptance criteria from markdown specs into deterministic REQ-<slug>-<n> records and attaches them to the QA context that feeds planning and generation. Activate when preparing to plan or generate tests, and whenever requirements are missing — then derive honestly from changed-file analysis, label the derivation INFERRED, and surface open questions instead of inventing product intent.
version: 0.1.0
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  cli: "qa plan"
  mcp: null
  agent: "RequirementsAgent.extract(paths?)"
  core: "QAContext.requirements (requirementSchema) persisted via .theqa/context.json; buildContext/parseContext"
---

# QA Requirements

## Purpose

Requirements turn "write some tests" into "verify THESE statements". `RequirementsAgent` parses markdown deterministically: level-1/2 headings become requirement titles, their `-`/`*` list items become acceptance criteria, and every requirement gets a stable id `REQ-<slug>-<index>` (global 1-based traversal order) plus a `must`/`should` priority derived from the literal word "must". The agent never invents requirements: when nothing parseable exists it returns an honest empty array, and this skill then governs the fallback — derive testable criteria from changed-file analysis and code contracts, label every derivation `INFERRED`, and put the unresolved product questions in front of a human. Requirements land in the `requirements` field of `.theqa/context.json` (Zod-validated `requirementSchema`) where `qa plan` and the generation pipeline consume them.

## When to activate

- Before `qa plan` or test generation: criteria are the enumeration input; no criteria, no plan.
- A spec file exists (README, `docs/**`, `requirements/*.md`) and its promises have never been verified.
- Requirements are absent for a changed area — activate the derivation path, do not skip modeling.
- A stakeholder statement ("the coupon should never stack") needs to become a numbered, verifiable criterion.
- Reconciliation: the same feature is described differently in two documents and one set of criteria must win, visibly.
- Post-release review: which criteria were actually verified vs assumed — the requirements array is the audit list.

## Inputs

| Input | Source | Required | Notes |
|---|---|---|---|
| `paths` | CLI args / explicit list | no | Default scan set: `README.md`, `docs/**.md` (any depth), `requirements/*.md` — sorted, capped at 20 files. Explicit paths may be absolute or root-relative. |
| Markdown files | filesystem | yes | Files > 5000 lines are skipped (documents, not specs); fenced code blocks are ignored (a `#` inside a fence is not a heading); nonexistent/unreadable files are skipped silently — extraction is best-effort. |
| Changed files | diff/impact analysis | no | Required for the derivation path when specs are absent: areas, symbols, and contracts of the change suggest the criteria. |
| Existing context | `.theqa/context.json` | no | `requirements` array (default `[]`); re-running replaces derivation with parsed facts. |
| Result shape | agent output | — | `Requirement { id, title, criteria: string[], source?, priority: 'must'\|'should'\|'could', status: 'draft'\|'agreed'\|'implemented'\|'verified' }` — shape-compatible with the core QAContext model. |

## Preconditions

- DISCOVER and MODEL have produced a context to attach requirements to (`qa plan` reads the validated context, not chat memory).
- Specs are markdown; the parser recognizes `#{1,2}` headings and `-`/`*` list items only. Numbered lists, tables, and deeper headings are NOT criteria — if the real spec lives there, the derivation path applies and its `INFERRED` label is mandatory.
- Requirement ids are deterministic given identical inputs — do not re-sort, re-slug, or renumber by hand; ids are references other records will cite.

## Decision rules

1. IF a heading (level 1–2) carries `-`/`*` list items, THEN it becomes one requirement with those items as criteria, id `REQ-<slug>-<n>` where `<slug>` is the slugified title (max 40 chars, `untitled` fallback) and `<n>` is the global 1-based index across the whole scan.
2. IF the title or any criterion contains the word "must" (case-insensitive, `\bmust\b`), THEN priority is `must`; otherwise `should`. Never assign `could` from parsing — that tier is reserved for human downgrades, and never upgrade `should` to `must` without the word being there.
3. IF a criterion is not verifiable (no observable outcome — e.g. "the system should be user-friendly"), THEN keep it but mark the requirement as needing refinement in the plan notes: vague criteria produce vague tests, and the vagueness must be visible where the tests are designed.
4. IF the scan yields zero requirements, THEN do NOT fabricate any: report the empty result honestly and trigger the derivation path (rules 5–8).
5. IF requirements are absent but a change set exists, THEN derive candidate criteria from the changed files: each changed source file's exported contract (function names, validation branches, error paths from the diff) yields one "it must <observable behavior>" statement, labeled `INFERRED` with the file paths as `source` — the derivation records what the CODE implies, never what the PRODUCT probably intended.
6. IF a derived criterion contradicts an existing requirement, THEN surface the contradiction as an open question to the human; never resolve product-intent conflicts silently in either direction.
7. IF code contracts are ambiguous (a validation function whose rejection set is unclear), THEN list the candidate readings as separate open questions instead of picking one — picking is inventing intent.
8. IF stakeholders are reachable in the workflow, THEN attach every open question to the plan output ("question → blocking which criterion") so answering unblocks generation; questions without a named consequence rot.
9. IF two documents describe the same feature, THEN keep both requirement sets, mark the later-traversed one as needing reconciliation, and let the plan state which set the tests will verify — do not merge criteria behind a human's back.
10. IF a requirement is verified by existing tests (per discovery inventory + coverage), THEN set `status: 'implemented'` only when an executed run supports it; parsing alone never advances status beyond `draft`.
11. IF the 20-file cap truncated the scan, THEN say which spec files were NOT read — an unread spec is not an absent requirement, it is `NOT_RUN`.
12. ALWAYS persist: write the final requirement array into `.theqa/context.json` (requirements field) before `qa plan` runs; requirements that live only in the conversation are requirements the next session cannot verify.

### Acceptance-criteria quality bar

A criterion is testable when it names an actor, an input or trigger, and an observable outcome: "applying an expired coupon is rejected with `COUPON_EXPIRED` and the cart total is unchanged". The parser captures text verbatim — quality enforcement is this skill's job: reject criteria whose outcome is subjective, hidden inside implementation detail ("calls `recalc()` twice"), or unobservable from any test layer. Rewrite proposals are suggestions attached to the requirement; the original text stays in `criteria` until a human agrees (`status: 'agreed'`).

### Derivation mechanics (when specs are absent)

The derivation path is a documented procedure, not a vibe: for each changed source file, read the diff-hunk signatures (added/changed exports, validation branches, error types) and write one criterion per observable contract, phrased as "it must <behavior>" with the file path in `source`. Evidence status is `INFERRED` end-to-end: the code describes what IS, requirements describe what SHOULD be, and only a human closes that gap. Business rules already encoded in code (guards, invariants, validation order) are legitimate derivation sources; aspirational behavior someone "plans to add" is not a criterion until it exists or a spec states it.

## Workflow

| Phase | Role of this skill |
|---|---|
| DISCOVER | Skip — discovery owns repo inventory; requirements may read its output for spec-file locations. |
| MODEL | **Primary phase**: extract (or derive) requirements → attach to context. |
| PLAN | Consumed: `qa plan` maps criteria → test cases and names coverage owners. |
| GENERATE | Consumed: acceptance criteria are the enumeration input for the generation pipeline. |
| VALIDATE | Check every generated case cites the requirement id it verifies. |
| EXECUTE | Not applicable (indirect: cases carry their requirement lineage). |
| OBSERVE | Not applicable. |
| TRIAGE | A REAL_REGRESSION on a covered criterion means the requirement was true and the code broke — triage cites the id. |
| HEAL | Not applicable. |
| VERIFY | Verify status transitions (`draft` → `verified`) only rest on executed evidence. |
| MEASURE | Requirements-with-verification vs total is an honest coverage-of-intent metric. |
| LEARN | Record repeatedly vague spec areas as review feedback for the team. |

## Anti-patterns

- Inventing a plausible-sounding requirement ("the API must rate-limit to 100 req/min") that no spec, human, or code contract states — invented numbers become invented tests become false confidence.
- Silently deriving requirements and presenting them as extracted facts: derivation is legal, silent derivation is not — `INFERRED` labels and open questions are the price.
- Treating every heading as a requirement: headings without list items yield titles with zero criteria — verify-nothing entries that pad the count (golden rule 15).
- Reformatting spec prose into criteria and overwriting the source text — `criteria` holds what the document says; rewrites are proposals.
- Letting the 40-char slug cap push two different requirements to colliding ids without the global index distinguishing them — ids are never hand-edited to "fix" collisions.
- Skipping the derivation path because "no spec means no requirements" — the change set still implies contracts that tests can verify, honestly labeled.
- Advancing `status` to `implemented`/`verified` because tests exist — status follows executed evidence, not file presence.
- Writing requirements in implementation vocabulary ("must call the validator before the repository") — criteria describe observable outcomes; implementation detail makes tests brittle to refactors that change nothing observable.

## Failure handling

- Spec file unreadable/nonexistent → skipped by the agent; list it as `NOT_RUN` in the report rather than pretending the scan covered it.
- File exceeds 5000 lines → skipped by design; propose splitting the document or extracting the spec sections into a dedicated file.
- Parser finds headings but no list items → requirements with empty criteria are reported as such; they are candidates for the derivation path, not silent drops.
- Malformed markdown (headings inside fences, stray `#`) → the fence-aware parser handles the documented cases; anything weirder is a human conversation, not a parser patch mid-run.
- Context write fails (`.theqa/context.json` not writable) → report and keep requirements in the session output with their ids; never let persistence failure silently discard extraction.
- Contradictory sources cannot be reconciled → both stay in the context with the open question attached; the plan may proceed on one set ONLY with the conflict recorded.
- A stakeholder answers an open question informally mid-session → update the requirement, cite the human and the answer verbatim in `criteria`, and move the question to a resolved note — informal answers left unrecorded re-open next session.

## Evidence requirements

- Extracted requirements: `OBSERVED` — each cites `source` (the file) and the text is verbatim from it; the agent quotes the heading and items when challenged.
- Derived (code-contract) requirements: `INFERRED` always — the label travels with the requirement into the context and the plan.
- Priority `must`: `OBSERVED` (the word is in the text) — any other priority reasoning is `INFERRED`.
- "This criterion is already covered by tests": `INFERRED` until selection/coverage mapping confirms it, `CONFIRMED` only after an executed run of the covering tests.
- Open questions: not evidence at all — they are explicit unknowns, and the report must not upgrade them to assumptions-as-facts.
- Status changes: `OBSERVED` (tied to run ids); a status without a run reference is `NOT_VERIFIED`.

## Safety constraints

- Safety class: `READ_ONLY` for extraction — the only write is the context file (`.theqa/context.json`), which is project scaffolding, not product code.
- No `--confirm-risk` path exists; requirements never touch production systems or CI.
- Golden rules engaged: 4 (no verification claims without execution evidence — status discipline), 14 (explainable decisions — every derived criterion carries its source paths), 15 (signal over count — zero-criterion requirements are flagged, not padded).
- Never encode secrets, credentials, or customer data from spec documents into requirement text; if a spec contains them, redact in the record and flag the document.

## Output contract

```json
{
  "schemaVersion": 1,
  "label": "INFERRED",
  "data": {
    "requirements": [
      {
        "id": "REQ-coupon-application-rules-1",
        "title": "Coupon Application Rules",
        "criteria": [
          "applying a valid coupon reduces the cart total by the coupon amount exactly once",
          "applying an expired coupon is rejected with COUPON_EXPIRED and the total is unchanged"
        ],
        "source": "docs/checkout-spec.md",
        "priority": "must",
        "status": "draft"
      },
      {
        "id": "REQ-usage-totals-per-tenant-2",
        "title": "usage totals are aggregated per tenant",
        "criteria": ["totals sum only that tenant's records", "an empty period yields 0, not an error"],
        "source": "changed-file derivation: app/api/usage.ts",
        "priority": "should",
        "status": "draft"
      }
    ],
    "openQuestions": [
      "Do coupons stack with sitewide sales? — blocks REQ-coupon-application-rules-1 criterion 1"
    ],
    "scan": { "filesRead": ["README.md", "docs/checkout-spec.md"], "filesSkipped": [], "capHit": false }
  }
}
```

`data.requirements[]` mirrors the `Requirement` shape (core `requirementSchema`); `label` is `OBSERVED` only when every requirement was parsed from files present this session — any derivation in the array keeps the aggregate at `INFERRED`.

## Examples

### Walkthrough 1 — extraction with a must
`qa plan` starts from `docs/checkout-spec.md`: two `##` headings, the first with three `-` items including the word "must". RequirementsAgent yields `REQ-coupon-application-rules-1` (priority `must`, 3 criteria) and `REQ-coupon-eligibility-2` (priority `should`). The agent applies rule 3: item "coupon codes are case-insensitive" is verifiable; item "coupon UX should feel instant" is not — kept, flagged for refinement. Context is updated (rule 12); the plan maps 4 of 4 verifiable criteria to unit/api cases and cites ids per case.

### Walkthrough 2 — honest derivation when no spec exists
A change set touches `app/api/usage.ts` (new endpoint aggregating per-tenant usage) and the repo has no docs. Rules 4–7 apply: the agent derives two criteria from the code contract (sum-per-tenant, empty period → 0), labels both `INFERRED` with the file as source, and posts two open questions ("is aggregation per calendar month or rolling 30 days? — blocks criterion 1"). It does not guess the answer, does not let generation design cases for the blocked criterion until someone answers, and the plan states exactly which criteria are blocked on humans.

## Verification checklist

- [ ] Every extracted requirement cites its source file and carries verbatim criteria text.
- [ ] Derived requirements are labeled `INFERRED` with the changed-file evidence, never presented as extracted.
- [ ] Requirement ids follow `REQ-<slug>-<n>` with the global traversal index — none were hand-renumbered.
- [ ] `must` priorities trace to the literal word in title/criteria; no silent upgrades or downgrades.
- [ ] Zero-criterion and unverifiable criteria were flagged, not dropped or padded.
- [ ] Open questions name the requirement/criterion they block and reached a human-visible surface.
- [ ] The requirements array was persisted to `.theqa/context.json` before planning.
- [ ] Status transitions (`implemented`/`verified`) rest on executed runs, not file presence.
- [ ] Skipped/unread spec files were listed as `NOT_RUN`, not omitted from the report.
- [ ] No requirement text contains secrets or customer data copied out of spec documents.
