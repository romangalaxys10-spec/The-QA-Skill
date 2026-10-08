---
name: token-efficiency
description: Context-window discipline for agents operating this QA OS — DTOC output caps, AST-first reading, progressive disclosure, and subagent scoping. Activate whenever an agent reads large files, ingests tool output, composes subagent prompts, or reports verbose results, so the working budget goes to the task instead of the noise.
version: 0.2.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings: ["qa tokens", "packages/core/src/tokens", "packages/xroutelm", "qa explain"]
---

# token-efficiency — context is working memory, not a junk drawer

## Purpose

An agent's context window is the scarcest resource in the loop, and most of it is wasted on verbose tool output: full-file reads, unbounded logs, diff dumps, and re-reads of files already seen. This skill defines the discipline the QA OS applies to its own output (DTOC caps on every report path, visible truncation markers, token estimates) and that agents should apply to their own behavior: read targeting before reading, compression before ingestion, and scoping before delegation. The measurable goal is simple — the same QA verdict with an order of magnitude less context spend.

This skill exists in this repository because the QA OS consumes agent context too: a triage report that dumps 200 log lines into a report costs more than the analysis it carries. Every cap here is enforced by executable code (`compressText`), not aspiration.

## When to activate

- Before reading any file: choose the smallest targeting step that answers the question.
- Before ingesting command output (build logs, diffs, listings) into a report, journal, or subagent prompt.
- When composing a subagent task description — scope it to the six documented fields.
- When a session's context use is growing faster than the task's progress and earlier phases can be compacted.
- When reporting to humans: the same caps apply; truncation is always visible.

## Inputs

- `kind` (enum): the output type determining the cap — `ls` (20 lines), `logs` (30), `diff` (100), `config` (80), `search` (40).
- `text` (string): the raw output under consideration.
- `file`, `lines` (for read auditing): the file and line range an agent proposes to read.
- `session cache` (optional): a map of previously read files with their ranges and summaries.

## Preconditions

- The output kind is known or can be inferred from the producing command (a diff is a diff).
- A truncation marker is available to append — output that must be truncated but cannot carry a marker must not be truncated silently.
- For read auditing: the proposed read's line count is known (it is the cost you are deciding about).

## Decision rules

- Cap order is fixed: ls 20 · logs 30 · diff 100 · config 80 · search 40. Logs and searches keep the TAIL (recent lines dominate); ls, config, and diffs keep the HEAD (structure dominates).
- Never read a file over 100 lines whole when a line-targeted read would answer the question; use search or AST queries first, then read only the matching ranges.
- Re-reads are bugs: before re-reading a file in the same session, consult the session cache; if the content changed, re-read only the changed ranges.
- Progressive disclosure: Tier 1 is structure (file list, symbol map), Tier 2 is targeted excerpts for the chosen targets, Tier 3 is full execution context for the active edit only. Never start at Tier 3.
- Subagent prompts carry exactly six fields: Task, Files, Structure, Relevant excerpt, Constraints, Output format. Anything more is leakage from the parent's context.
- Truncation is always visible: the marker records how many lines were dropped, of how many, and the cap that caused it.

## Workflow

1. Identify the kind of the output and its cap.
2. Apply `compressText(kind, text)` (or `qa tokens --type <kind> <file>`): caps enforced, marker appended, token delta reported (chars/4 estimate).
3. Ingest the compressed output; keep the marker — it is part of the evidence that the view is partial.
4. For file reads: search → line-targeted read → whole-file read only when the file is under the 100-line floor or the task is an audit.
5. For subagent delegation: write the six-field scope; include line ranges, not files.
6. When context pressure is high, compact finished phases into their verdicts ("phase X done: outcome, evidence path") and drop the transcript.

## Anti-patterns

- Pasting a 400-line log into a report because "the reader can scroll" — the reader is an agent with a budget.
- Silent truncation: dropping lines without a marker turns partial evidence into false confidence.
- Reading whole files to answer a one-symbol question; grep and AST queries exist.
- Subagent prompts that say "look at the repo" — an unscoped subagent re-discovers the parent's context at full price.
- Skipping the session cache and re-reading the same file every turn.

## Failure handling

- Unknown kind: refuse to invent a cap — ask for the kind or default to `search` (the most conservative) with the choice recorded.
- Output with no safe truncation point (single-line huge string): report the token count and require an explicit decision instead of splitting blindly.
- Cache poisoning (file changed since cache): the cache stores a mtime/size fingerprint; on mismatch, the entry is invalidated and the re-read is charged honestly.

## Evidence requirements

Every compression records: kind, original and kept line counts, tokens before and after, and the marker text. Every read audit records the proposed file, its line count, and whether the floor was violated. These records are what make the discipline auditable — `qa tokens` output is itself evidence.

## Safety constraints

- Compression never alters semantic content: it drops lines whole and says so; it never summarizes in a way that could invent facts.
- Evidence bundles are exempt from capping when written to disk (artifacts keep full fidelity); caps apply to context ingestion and reports, not to persisted evidence.
- Secret scrubbing still applies after truncation — a cap is not a redaction.

## Output contract

`qa tokens` (and the `compressText` core API) returns:

```json
{
  "kind": "logs",
  "originalLines": 60,
  "keptLines": 30,
  "truncated": true,
  "marker": "[… DTOC: 30 of 60 lines truncated (cap 30 for logs) …]",
  "tokensBefore": 178,
  "tokensAfter": 104
}
```

## Examples

**Compress a build log** — `qa tokens --type logs build.log` → 60 lines become the marker plus the last 30; tokens drop 178 → 104; the marker travels with the output into the report.

**Read audit** — an agent proposes reading a 350-line source file; the audit flags the violation and points at `rg -n "scoreCard"` followed by a 20-line targeted read, which answers the same question for 6% of the tokens.

**Subagent scope** — instead of "investigate the flaky test in tests/e2e", the scoped prompt reads: Task (classify failure flake-vs-regression for `checkout.spec.ts#L88`), Files (that file, lines 70–110; `src/checkout/total.ts`), Structure (test body + the price-mapping function), Relevant excerpt (the 12 lines around the assertion), Constraints (no edits; label every conclusion), Output format (triage JSON per the core schema).

## Verification checklist

- [ ] `qa tokens` output always carries the marker when `truncated` is true, with the dropped/total line counts.
- [ ] No report path in this OS emits uncapped logs, diffs, or listings — spot-check `qa triage --verbose` output length against the caps.
- [ ] Token estimates are reported alongside every compression (before and after).
- [ ] Evidence written to artifacts is uncapped; only context ingestion and reports are capped.
- [ ] A subagent prompt produced under this skill fits the six-field scope and names line ranges, not whole files.
