#!/usr/bin/env bash
# The-QA-Skill — POSIX-style shell wrapper for the `qa` CLI.
#
# Copy into your repository (e.g. scripts/qa.sh) and run:
#
#   ./scripts/qa.sh              # full pipeline: doctor -> impact -> test -> gate
#   QA_POLICY=nightly ./scripts/qa.sh
#
# Requires: the `qa` CLI available (npm i -D the-qa-skill), git, jq.
# Exit codes: 0 = gate passed; 1 = gate BLOCKED or a hard step failed;
#             2 = usage/tooling problem.
#
# Documented commands only: qa doctor | qa impact --range <r> --json |
# qa test --policy <p> | qa release --json. Full 16-command surface: CLI docs.

set -euo pipefail
# `pipefail` is bash/zsh/ksh, not POSIX sh; if this script is run by a strict
# POSIX shell, drop it rather than die on the set line above.
(set -o pipefail) 2>/dev/null || true

# --- configuration (override via environment) ------------------------------
QA_CMD="${QA_CMD:-npx qa}"                        # how to invoke the CLI
QA_BASE_REF="${QA_BASE_REF:-origin/main}"         # impact base branch
QA_RANGE="${QA_RANGE:-}"                          # explicit range wins
QA_POLICY="${QA_POLICY:-pr}"                      # pr | pre_merge | nightly | release | post_deploy
QA_ARTIFACTS_DIR="${QA_ARTIFACTS_DIR:-.theqa/artifacts}"

say() { printf '%s\n' "$*"; }

command -v git >/dev/null 2>&1 || { say "qa.sh: git is required"; exit 2; }
command -v jq >/dev/null 2>&1 || { say "qa.sh: jq is required for the gate verdict"; exit 2; }

mkdir -p "${QA_ARTIFACTS_DIR}"

# --- 1. doctor (advisory — findings never block this wrapper) ---------------
say "== qa doctor (advisory)"
if ! ${QA_CMD} doctor; then
  say "qa doctor reported problems (advisory) — see output above; continuing."
fi

# --- 2. impact for the change range -----------------------------------------
if [ -z "${QA_RANGE}" ]; then
  QA_RANGE="${QA_BASE_REF}..HEAD"
fi
say "== qa impact --range ${QA_RANGE}"
${QA_CMD} impact --range "${QA_RANGE}" --json > "${QA_ARTIFACTS_DIR}/impact.json"
say "   impact written to ${QA_ARTIFACTS_DIR}/impact.json"

# --- 3. test under the configured policy ------------------------------------
say "== qa test --policy ${QA_POLICY}"
${QA_CMD} test --policy "${QA_POLICY}"

# --- 4. release gate: the only step that fails the run ----------------------
# ReleaseGateResult verdict: PASS | PASS_WITH_WARNINGS | BLOCKED | FAIL | UNKNOWN.
say "== qa release (gate)"
${QA_CMD} release --json | tee "${QA_ARTIFACTS_DIR}/release-gate.json"
verdict="$(jq -r '.verdict // .data.verdict // "UNKNOWN"' "${QA_ARTIFACTS_DIR}/release-gate.json")"
say "   gate verdict: ${verdict}"

case "${verdict}" in
  BLOCKED)
    say "QA release gate BLOCKED — inspect ${QA_ARTIFACTS_DIR}/release-gate.json"
    exit 1
    ;;
  *)
    say "Gate passed (verdict: ${verdict})."
    exit 0
    ;;
esac
