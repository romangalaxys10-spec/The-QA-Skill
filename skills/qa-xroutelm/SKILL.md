---
name: qa-xroutelm
description: xRouteLM — the portable System One decision engine and agent harness behind task routing, urgency gating, and model selection. Activate whenever a decision needs a fast typed answer (which engine owns this task, is this urgent, fast or powerful model) without a full LLM call, and as the Laya alternative on platforms where Laya cannot run.
version: 0.2.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings: ["qa route", "packages/xroutelm", "xroutelm CLI", "MCP tool route_task", "Orchestrator routing stage"]
---

# qa-xroutelm — System One decisions for the QA operating system

## Purpose

xRouteLM answers structured questions about a state with calibrated probabilities instead of generated text — the same question semantics Jev standardized (choice / score / noul), implemented with a portable scorer pipeline so it runs anywhere Laya cannot: no macOS requirement, no MLX, no Apple Silicon, no external API, no Jev itself. Inside this operating system it owns three decisions: which QA engine should own a task (`qa route`), whether an agent loop should proceed past a gate, and which model tier (fast vs powerful) a step deserves. The engine returns typed answers with probabilities and recorded evidence; code acts on the answers directly.

The design principle is System One over System Two: a routing or gating decision is a classification, and paying an LLM for it wastes latency and tokens. xRouteLM makes those decisions deterministic, auditable, and effectively free. When a heuristic scorer is genuinely uncertain, it says so — low confidence falls back to a documented default instead of a confident guess.

## When to activate

- A task description must be routed to one of the QA engines or skills and there is no explicit user instruction naming one.
- An agent loop needs a cheap yes/no gate (proceed, retry, escalate, quarantine) evaluated from the current state.
- A step must choose between a fast model and a powerful model and the difference is in the task shape, not the user's wallet.
- Laya would normally provide on-device triage but the platform is Linux, Windows, or Intel macOS.
- A routing decision is later questioned and its evidence must be replayed from the decision journal.

Do not activate for open-ended reasoning, code generation, or anything needing natural language synthesis — that is System Two work for a real model. xRouteLM classifies; it does not write.

## Inputs

- `state` (string, required): the task text, failure record, diff summary, or agent-loop state the questions are about. One state can carry many questions.
- `questions` (typed, required): one or more of —
  - `noul` `{ instructions, keywords?, negativeKeywords? }` — probability that the instruction is true of the state.
  - `choice` `{ instructions, options: [{ id, description, keywords? }] }` — probability per option; the selected option is the highest.
  - `score` `{ instructions, levels: [low…high], levelKeywords? }` — a 0..1 score and the selected level bucket.
- `targets` (for routing): engine/skill ids with descriptions and keyword anchors; extended by `xroutelm.plugin.json` manifests.
- `stats` (optional): `.xroutelm/route-stats.jsonl` outcomes feeding success-rate learning.

## Preconditions

- The scorer registry resolves at least one available scorer (the heuristic scorer is always available; the Laya bridge is feature-detected and reports why it is unavailable when it is).
- For `qa route`: a non-empty task description.
- For learning: the stats file, when present, must be readable JSONL; a corrupt file is ignored (advisory data) — never a blocker.
- Routing quality depends on target descriptions being current: when a new skill or engine is added, its description and keywords belong in `defaultTargets()` or a plugin manifest.

## Decision rules

- Route to the highest-probability target when its confidence ≥ the fallback floor (default 0.35); otherwise return the configured fallback target and mark `usedFallback: true` — never present a low-confidence guess as a decision.
- Gate loops: `proceed = true` only when every `noul` question ≥ threshold (default 0.5); a single failed gate blocks and the reasons array records each contribution.
- Model routing: pick `fast` for direct lookups, extraction, and localized changes; pick `powerful` for debugging, concurrency, and architecture work — the criteria live in the config, the answer in the probabilities.
- Learning: targets with ≥5 recorded samples and <0.3 success drop one rank; ≥0.7 rise one rank. The adjusted order is visible in output; behavior never changes silently.
- Confidence is a function of measured evidence (margin between top options, anchored overlap) — no confidence number in this package is a constant.

## Workflow

1. Collect the state text and the questions to ask (or the target list for routing).
2. Resolve the scorer: preferred scorer if available, else the first available in registry order; record every fallback and its reason.
3. Evaluate: tokenize, IDF-weight the corpus, score each question, calibrate raw similarity to bounded probabilities (logistic, clamped to 0.02–0.98).
4. Journal the decision (state hash, answers, evidence, scorer id) to `.xroutelm/decisions.jsonl`.
5. Act on the answers in code: route the task, open or block the gate, pick the model.
6. After the outcome is known, record it (`RouteStats.record`) so future routing learns.

## Anti-patterns

- Using an LLM to pick between eight known engines — that is a System One decision wearing a System Two costume.
- Treating a low-confidence route as a decision instead of taking the documented fallback.
- Adding target keywords that describe what a target does in general rather than what tasks look like when they need it.
- Silently swapping the scorer on a platform: fallbacks are recorded in the decision set, never hidden.
- Reading the journal as ground truth about the world — it records what was decided and why, not whether the decision was right; that is what RouteStats outcomes are for.

## Failure handling

- No scorer available (cannot happen with the default registry, possible with a custom one): the engine throws with the registry contents; the caller surfaces the error instead of improvising.
- Scorer throws mid-evaluation (e.g. Laya bridge on a broken Python env): the registry falls to the next available scorer and records the fallback; if none remain, the error propagates.
- Malformed plugin manifests: reported in `pluginErrors` with the path and reason; valid plugins still load — one bad file never blanks the target list.
- Empty task or zero questions: usage error, exit 2, with the syntax hint; nothing is decided, nothing is journaled.

## Evidence requirements

Every decision carries: scorer id (including fallback chain), per-answer matches (`token`, `weight`, `source`), raw similarity before calibration, margin for choices, and wall-clock duration. The journal line adds a timestamp and state hash so a decision can be replayed byte-for-byte. Routing reports list the top matched anchors — an operator should be able to see why `qa-flake-detection` won without reading the source.

## Safety constraints

- Routing and decisions are READ_ONLY: they never execute target commands by themselves. Harness tool execution is a separate, policy-gated layer.
- Refusal semantics: a blocked gate is a normal result, not an error — exit codes and envelopes must let callers distinguish "answered no" from "could not answer".
- No state mutation without an explicit path: the journal and stats files are written only to their configured locations.
- The heuristic scorer's probabilities are calibrated lexical evidence, not measurements of production outcomes; they are labeled INFERRED everywhere they leave the package.

## Output contract

`qa route` (and the MCP `route_task` tool) returns:

```json
{
  "task": "flaky checkout test intermittently fails on retry in CI",
  "decision": {
    "target": "qa-flake-detection",
    "confidence": 0.97,
    "probabilities": { "qa-flake-detection": 0.87, "qa-test-healing": 0.06 },
    "fallback": ["qa-test-healing", "qa-failure-triage"],
    "scorer": "xroutelm/heuristic",
    "evidence": { "matches": [{ "token": "flaky", "weight": 0.22, "source": "anchor" }], "rawScore": 0.61 },
    "label": "INFERRED"
  },
  "pluginErrors": []
}
```

A gate decision returns `{ proceed, reasons[], decisions }`; a model-routing decision returns `{ model, confidence, usedFallback }`.

## Examples

**Route a task** — `qa route "payment total is wrong after applying a discount coupon at checkout"` → `qa-risk-analysis` (confidence 0.97; anchors: payment, checkout, coupon). The fallback chain lists every other target in probability order.

**Gate an agent loop** — a triage agent asks `{ name: "needs_full_regression", question: { type: "noul", instructions: "This change touches payment or auth logic", keywords: ["payment", "auth", "charge"] } }` about the diff summary; a 0.91 noul opens the regression branch, 0.31 takes the fast path — both recorded with their evidence.

**Laya bridge honesty** — `xroutelm doctor` on Linux prints `UNAVAILABLE xroutelm/laya-bridge — requires macOS (platform is linux)` and the engine routes via `xroutelm/heuristic`; on an Apple Silicon Mac with the Laya runtime present the same command prints AVAILABLE and noul questions may delegate on-device.

## Verification checklist

- [ ] `qa route "<task>"` returns a decision whose target exists in `defaultTargets()` or a loaded plugin manifest, with a fallback chain and evidence matches.
- [ ] The JSON envelope carries `label: "INFERRED"` on every decision and `scorer` names the scorer actually used (including fallback chain).
- [ ] `xroutelm doctor` reports every scorer's availability with a real reason string for anything unavailable.
- [ ] A gate with one below-threshold noul question blocks, and `reasons` shows the failing contribution.
- [ ] Refuted or low-confidence routing never mutates the learning file; only recorded outcomes do.
- [ ] The decision journal exists after a routed task and its `stateHash` matches the reported one.
