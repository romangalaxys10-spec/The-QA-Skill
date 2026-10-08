# The-QA-Skill — CI templates

Ready-to-copy pipelines for projects that have The-QA-Skill installed.
Every template drives the same spine, mapped onto each CI system's idioms:

```
qa doctor (advisory) → qa impact --range <base>..HEAD → qa test --policy <policy>
→ artifact upload (.theqa/artifacts) → qa release gate (fails on BLOCKED)
```

Nightly variants swap the PR policy for the nightly policy and add the
nightly-only intelligence: `qa flake`, `qa coverage`, `qa report`.

## Which file goes where

| Template | Copy to | Runs |
| --- | --- | --- |
| [`github-actions/qa-pr.yml`](github-actions/qa-pr.yml) | `.github/workflows/qa-pr.yml` | On every pull request |
| [`github-actions/qa-nightly.yml`](github-actions/qa-nightly.yml) | `.github/workflows/qa-nightly.yml` | Cron (02:30 UTC) + manual dispatch |
| [`gitlab-ci/gitlab-ci.yml`](gitlab-ci/gitlab-ci.yml) | `.gitlab-ci.yml` | MR pipelines + scheduled pipelines |
| [`jenkins/Jenkinsfile`](jenkins/Jenkinsfile) | `Jenkinsfile` | Multibranch/PR builds |
| [`azure/azure-pipelines.yml`](azure/azure-pipelines.yml) | `azure-pipelines.yml` | PR/CI builds + nightly schedules |
| [`shell/qa.sh`](shell/qa.sh) | `scripts/qa.sh` | Anywhere: locally, cron, any CI |

## Prerequisites

1. Install the CLI in your project: `npm i -D the-qa-skill` (provides the `qa`
   binary). Repo-local builds work too — point `QA_CMD` (shell template) at
   your local `qa` entry point and replace `npx qa` in the CI files.
2. Commit messages and history must be reachable from CI: the GitHub, GitLab
   and Azure templates fetch full history (`fetch-depth: 0` / merge-base SHA)
   so `qa impact --range "<base>..HEAD"` sees the real change set.
3. `jq` must be on the agent image for the gate step (preinstalled on GitHub
   hosted runners, `node:20` + common Jenkins/Azure agents).

## Environment variables

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `QA_BASE_REF` | all PR pipelines | `origin/main` | Branch the impact range is diffed against. Change if your default branch differs. |
| `QA_RANGE` | `shell/qa.sh` | `<QA_BASE_REF>..HEAD` | Explicit override; wins over `QA_BASE_REF`. |
| `QA_POLICY` | `shell/qa.sh`, Azure | `pr` (nightly on schedules) | `pr` \| `pre_merge` \| `nightly` \| `release` \| `post_deploy` — the orchestration policy `qa test` runs. |
| `QA_CMD` | `shell/qa.sh` | `npx qa` | How to invoke the CLI (e.g. `node /path/to/qa.js`). |
| `QA_ARTIFACTS_DIR` | `shell/qa.sh` | `.theqa/artifacts` | Where reports and gate JSON are written. |
| `SLACK_WEBHOOK_URL` | nightly templates | unset | **Explicit opt-in only.** When the secret is set, the nightly posts its result to Slack (an external-system side effect). Leave unset to keep the run fully local. |
| `NOTIFY_SLACK` | Jenkins | `false` | Same opt-in, as a build parameter; the webhook comes from the `qa-slack-webhook-url` credential. |

## The gate contract

Every template ends in the same gate step and treats it as the **only** step
allowed to fail the run on quality grounds:

```sh
npx qa release --json | tee .theqa/artifacts/release-gate.json
verdict="$(jq -r '.verdict // .data.verdict // "UNKNOWN"' .theqa/artifacts/release-gate.json)"
# PASS | PASS_WITH_WARNINGS -> merge proceeds
# BLOCKED                   -> job fails (exit 1)
# FAIL | UNKNOWN            -> reported, not blocking (FAIL is reserved for
#                              human override; UNKNOWN means insufficient data)
```

The jq fallback chain (`.verdict // .data.verdict`) tolerates both the bare
`ReleaseGateResult` shape and the wrapped `schemaVersion:1 {data, label}`
output contract. If your CLI version emits a different envelope, adjust the
jq path in the gate step — the verdict vocabulary itself is fixed by the
release-gate engine.

## Customization notes

- **Commands and flags.** The templates use only the documented 16-command
  surface (`init discover plan risk generate review test impact triage heal
  flake coverage release report doctor explain`) with these flags:
  `qa impact --range <git-range> --json`, `qa test --policy <name>`,
  `qa release --json`. Everything else is invoked bare (`qa doctor`,
  `qa flake`, `qa coverage`, `qa report`). Don't invent flags — if your CLI
  version supports more, add them deliberately.
- **Artifacts.** All templates upload/publish `.theqa/artifacts` (the
  platform's default artifact directory) with `when: always` /
  `succeededOrFailed()` semantics so evidence survives red runs.
- **Doctor is advisory.** `qa doctor` describes the environment; its findings
  are surfaced (`continue-on-error: true` / `allow_failure: true` /
  `continueOnError: true` / captured exit code) but never block — the gate is
  the single blocking authority. This mirrors the platform's rule that
  environment findings and quality verdicts must not be conflated.
- **Jenkins JUnit.** The Jenkinsfile publishes `junit` from
  `.theqa/artifacts/**/*.xml` with `allowEmptyResults: true` — an empty result
  set is reported honestly instead of failing the publish step.
- **GitLab anchoring.** The GitLab template uses a YAML anchor
  (`.node-artifacts`) for the shared `artifacts:` block; hidden keys (`.`
  prefix) are ignored by GitLab.
- **Schedules.** Nightly crons are placeholders (02:30 UTC); move them to your
  low-traffic window. Azure uses `Build.Reason == 'Schedule'` to switch the
  policy and enable the flake/coverage steps; GitLab keys jobs off
  `CI_PIPELINE_SOURCE == "schedule"`.
- **Monorepos.** If `qa` runs from a subdirectory, set the working directory
  per job (GitHub: `defaults.run.working-directory`, Azure: `workingDirectory`,
  GitLab: job-level `variables` + `cd`, Jenkins: `dir('subdir') { sh ... }`).

## Honesty note

These templates only orchestrate the CLI; they compute no quality numbers
themselves. Every metric shown in CI comes from the deterministic engines (or,
if configured, your documented reasoning provider) — the templates never
fabricate or cache a verdict.
