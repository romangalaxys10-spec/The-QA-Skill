---
name: qa-mobile
description: Mobile testing strategy for the 'e2e' layer with an explicit device matrix — Appium capability mapping through the platform-neutral adapter, mobile-specific failure classes, and flakiness controls for device farm runs. Device identity rides on every TestEvent, and cloud farm execution is treated as an external system requiring confirmation.
version: 0.1.0
license: MIT
sponsor: xShredo.dev
sponsor_url: https://xshredo.com/promo/anytest
platforms: [claude-code, cursor, github-copilot, windsurf, codex, cline, zed, gemini-cli]
bindings:
  - runners:appium (AppiumRunner: `npx wdio run wdio.conf.js`; JUnit parsing; device from runner context)
  - runners:appium:mapCapabilities (platformName W3C-native; app/automationName/deviceName under 'appium:' prefix)
  - core:evidence/bundle (metadata carries device; screenshots/logs bundled per failure)
---

# QA Mobile

## Purpose

Make mobile E2E testing reproducible despite the two things that make mobile hard: a matrix of devices/OS versions, and an operating system that interrupts your test at will (calls, notifications, permission prompts, backgrounding). The platform's Appium adapter is deliberately an adapter surface — it maps neutral capabilities onto W3C Appium capabilities and parses JUnit output; it does not install emulators or manage device farms. This skill defines the strategy that lives above that surface: matrix selection, failure-class literacy, and vendor-neutral execution discipline.

## When to activate

- A change set ships user-facing mobile behavior (native screens, hybrid webviews, deep links, push handling).
- You are asked to "add device coverage", "fix flaky Appium tests", or choose between real devices and emulators.
- A failure only reproduces on a device (network transitions, interrupts, lifecycle) and desktop tests are green.
- A cloud farm (BrowserStack/Sauce-style) run must be wired in without coupling the repo to one vendor.
- Interrupt/lifecycle coverage (calls, notifications, backgrounding) is requested for an existing suite.

## Inputs

| Input | Source | Required | Notes |
| --- | --- | --- | --- |
| Capability input | platformName, deviceName, platformVersion, app, automationName | yes | Platform-neutral; `mapCapabilities` does the W3C mapping |
| Device matrix | traffic analytics × risk | yes | Top real devices for critical paths; emulators for breadth |
| App package | path/URL to APK/IPA (capability `app`) | yes | Versioned build artifact, pinned per run |
| wdio configuration | `wdio.conf.js` (repo-owned) | yes | Where real devices/servers are actually wired |
| Farm credentials | env-backed | if cloud | Never committed; scrubbed from artifacts |
| Failure bundles | `writeEvidenceBundle` | on failure | metadata.device identifies the cell |

## Preconditions

- The Appium runner is detectable: appium/webdriverio/@wdio/cli in package deps, or wdio.conf.*, appium.config.*, .appiumrc, or appium.yml present.
- The repo owns its wdio configuration — the adapter parses what that configuration produces; it does not start servers or attach devices. If nothing is wired, the layer is NOT_RUN and says so.
- Accessibility ids are stable on the screens under test; gesture tests on unlabeled elements are refused at generation time.
- The app build under test is pinned (capability `app` points at a versioned artifact) — testing "whatever is installed" is not reproducible (golden rule 12).

### Choosing the matrix cell list (a risk decision, recorded next to the suite)

- **Tier 1 — real devices (few):** the device/OS cells that carry most of the traffic; gestures, cameras, biometric-adjacent and telephony behavior are only real here.
- **Tier 2 — emulators/simulators (breadth):** OS versions and screen densities for regression detection at CI speed.
- **Tier 3 — cloud farm (on demand):** cells CI cannot host; metered spend, HIGH_RISK confirmation, scheduled rather than per-PR.

Every planned cell names its device model, OS version, and app build — a cell that cannot state those three is not a cell, and a cell with no spec mapped to it is a gap, not coverage.

## Decision rules

1. If capabilities are needed → build the neutral `AppiumCapabilityInput` and let `mapCapabilities` emit W3C form: `platformName` native; `deviceName`/`platformVersion`/`app`/`automationName` namespaced `appium:`; every `extra` entry becomes `appium:<key>` so vendor keys never leak into the W3C namespace.
2. If the device matrix must be chosen → top real devices for the revenue/UX-critical paths (touch ID, gestures, real radios), emulators/simulators for matrix breadth and CI speed; document the split and revisit it against traffic data — never "all devices" or "one device".
3. If a test fails with `stale element reference` or `NoSuchElement` shapes → SELECTOR_PATTERNS classify it: SELECTOR_FAILURE at 0.9 when the selector literal appears in the product diff, 0.6 otherwise (product regression or pre-broken test); a pass-on-retry with no changed code is the TIMING_FAILURE path (0.7) — fix waits on real state, not sleeps (golden rule 3).
4. If a failure reproduces only across network transitions (offline→online, Wi-Fi→cellular) → model transitions as explicit state-machine steps with assertions per state; do not treat the flake as random.
5. If OS permission dialogs interrupt flows → treat permissions as states: pre-grant via platform mechanisms where possible, otherwise script the dialog interaction; an unmanaged dialog is a nondeterministic test.
6. If the app is backgrounded/foregrounded/killed mid-flow → assert the lifecycle behavior explicitly (state restoration, deep-link re-entry); these are product behaviors, not test noise.
7. If the screen under test is a hybrid webview → switch context explicitly (native ↔ webview), assert within one context at a time, and never mix native and web selectors in a single query; context confusion is a classic phantom failure.
8. If execution targets a cloud device farm → keep the neutral capability input as the contract, pass vendor extras only through `extra` (they land namespaced), and classify the farm run as `external.systems` HIGH_RISK (it spends money and reaches third-party infrastructure): require `--confirm-risk`; parse whatever JUnit the farm's runner emits.
9. If an interrupt (call, notification, low battery) is part of the scenario → script it as a first-class step with the recovery assertion; unplanned interrupts are recorded as ENVIRONMENT_FAILURE, not product bugs.
10. If biometrics are required (fingerprint/FaceID-style unlock) → simulate via the platform's stub/enrollment mode as an explicit state; never process real biometric data, and never gate a release on hardware-specific behavior that CI cannot reproduce (label that path NOT_RUN).
11. If a test relies on keyboard behavior (autocorrect, suggestion bars) → disable predictive text in capabilities where the platform allows, and assert on the value, not the keystroke path.
12. If a device cell cannot run a spec (unsupported OS feature) → mark the cell skipped with a reason; silently running the wrong matrix cell fabricates coverage.

## Workflow (12-phase lifecycle)

1. **DISCOVER** — detect the Appium/WDIO setup; inventory layer `e2e` specs tagged for mobile; read existing `wdio.capabilities.json` if present (`readCapabilities`).
2. **MODEL** — map the diff to screens and flows; list OS surfaces in play (permissions, notifications, backgrounding) and the matrix cells that matter.
3. **PLAN** — fix the matrix (devices × OS versions × app build); decide local emulator vs farm per policy; state interrupt scenarios explicitly.
4. **GENERATE** — scaffold specs with stable accessibility ids, explicit context switches for hybrid screens, and state-machine steps for permissions/transitions.
5. **VALIDATE** — quality pass: no raw coordinate taps where an element exists, no sleeps in place of waits, each spec declares its target capabilities.
6. **EXECUTE** — run through the Appium adapter (`npx wdio run wdio.conf.js`); farm runs only with `--confirm-risk` (rule 8).
    One app build per run across cells: mixing builds mid-matrix makes cell comparisons meaningless.
7. **OBSERVE** — bundle failures with metadata.device populated (the runner maps context browser → device identity), plus device screenshots and server/app logs.
8. **TRIAGE** — apply the failure-class map: element-not-found → selector path (rule 3); interrupt noise → environment path; context/lifecycle failures → product behaviors.
9. **HEAL** — locator-strategy healing may propose accessibility-id queries; it may never swap a real assertion for a sleep or a coordinate tap.
10. **VERIFY** — re-run the failed cell on the SAME device/OS/app build; a mobile failure is closed only on the cell that failed, not on "some emulator".
11. **MEASURE** — per-cell flake scores (the multi-environment fields of the flake scorer exist for exactly this); track which matrix cells earn their runtime.
12. **LEARN** — record interrupt/lifecycle defect patterns and unstable cells; feed matrix decisions (which emulators to retire) back with data.

### Mobile failure classes (the triage literacy TRIAGE applies before any category is chosen)

| Class | Signature | Triage route |
| --- | --- | --- |
| Stale/missing element | `stale element reference`, `NoSuchElement` | SELECTOR_FAILURE (0.9 with diff literal / 0.6 without) |
| Late element | pass on retry, no changed code | TIMING_FAILURE (0.7); fix waits, not sleeps |
| Interrupt noise | call/notification banner in screenshots | ENVIRONMENT_FAILURE; script it or isolate it |
| Network transition | fails only after connectivity change | explicit state machine; FLAKE if unmanaged |
| Context confusion | webview assertion errors on native screen | product/test defect at the context switch |
| Lifecycle | fails after background/kill + relaunch | product behavior; assert restoration explicitly |
| Permission dialog | unexpected system dialog blocks flow | manage as state; unmanaged = environment noise |
| Keyboard interference | value assertions fail with autocorrect artifacts | disable predictive input; assert on values |

## Anti-patterns

- Absolute coordinate taps instead of element interactions — invisible coupling to one device's layout.
- `driver.sleep(5000)` as the wait strategy — penalized by the determinism dimension and broken by any device slowdown (golden rule 3).
- One "sign-in" mega test walking the whole app — mobile suites need small flows that can survive interrupts.
- Hardcoding farm credentials or device farm URLs with embedded keys in wdio.conf — env-backed only (golden rule 8).
- Claiming device coverage from an emulator run (or vice versa) — the matrix cell is part of the evidence; wrong-cell claims are lies.
- Coupling the repo to one vendor's SDK-specific capability names outside `extra` — the neutral input is the contract; vendors are swappable.
- Ignoring OS interrupts because "CI doesn't have those" — production phones do; unmodeled interrupts are tomorrow's flakes.
- Treating a green emulator run as release coverage for a real-device tier — the matrix cell, not the suite, defines what was verified; wrong-cell claims are the mobile form of a false pass.
- Testing deep links and push entry points only through the UI that launches them — entry points are product surfaces; a flow verified only from its happy entry point is unowned risk.
- Asserting webview content while still attached to the NATIVE context (or the reverse) — the assertion silently targets nothing and the failure teaches nothing.

## Failure handling

- Emulator/simulator or farm session fails to start → NOT_RUN for affected cells with the session log bundled; do not fall back to a different cell and present it as the same coverage.
- App under test crashes on launch → deterministic failure; triage as a product regression candidate if the build or related code changed, else a build-artifact problem.
- Farm returns partial JUnit (session died mid-suite) → parse what exists; the unreported remainder is NOT_RUN, never inferred green.
- Interrupt storm on a shared farm account (other teams' traffic) → record environment contention; re-run isolated or move the cell.
- `readCapabilities` finds no capability file → generation proceeds from the neutral input; execution waits for repo-owned wdio wiring.
- Farm substitutes a different device than the requested cell → the run's cell identity is a lie; record the substitution in the bundle, re-run on the requested cell, or re-label the matrix — never report substituted coverage as the planned cell.
- Webview context list is empty on a hybrid screen → the webview is not ready or the context-switch API is misconfigured; that flow is NOT_RUN until fixed, not asserted against a dead context.
- Deep link lands on the wrong screen state → assert entry-point behavior as its own case before blaming the flow behind it; deep-link routing is a product surface with its own defects.

## Evidence requirements

- Every failure bundle carries metadata.device (from the runner context), the app build reference, and the capability input used — three things minimum to reproduce a mobile failure (golden rule 12).
- Device artifacts: screenshot at failure, Appium server log excerpt, and app logs where collectable — bundled after scrubbing (golden rule 8; farm tokens and session URLs must not survive into artifacts).
- Labels: OBSERVED for failures with device artifacts on a named cell; CONFIRMED after a same-cell clean re-run; INFERRED for classifications from log shapes without device artifacts; NOT_RUN for cells that never executed (including hardware-gated paths like real biometrics); NOT_VERIFIED for findings missing the matrix-cell identity.
- Multi-cell verdicts: a behavior is only "stable" when its cells agree; the flake scorer's environment/browser diversity inputs are the mechanism — a test failing across many devices is a different signal than one failing on one.

## Safety constraints

- `test` (local emulator/simulator runs) → READ_ONLY for tracked sources; device artifacts go to untracked bundle dirs.
- `generate` (scaffolding mobile specs and capability files) → LOW_RISK_WRITE (generated-tests directory; never overwrites existing wdio.conf).
- Cloud device farm execution → HIGH_RISK (`external.systems`): third-party infrastructure and metered spend; requires `--confirm-risk` and env-backed credentials.
- Installing the app build on personal/shared physical devices → treat as HIGH_RISK unless the device pool is explicitly provisioned for testing.
- Golden rules in force: 1 (never weaken device assertions to pass a cell), 2 (no retry-washing across cells), 3 (waits on state, never sleeps), 4 (no verification claims without device artifacts), 6 (tests isolated per device session — no shared device state), 8 (secrets scrubbed from bundles), 9 (no unauthorized devices/farms), 12 (build + capabilities + cell recorded for reproducibility), 15 (matrix cells earn their runtime with signal).

## Output contract

```json
{
  "schemaVersion": "qa.mobile.v1",
  "data": {
    "testId": "tests/mobile/checkout.e2e.spec.js::applies coupon after app restore",
    "layer": "e2e",
    "cell": { "device": "Pixel 7", "platform": "Android", "platformVersion": "14", "automation": "UiAutomator2", "appBuild": "checkout-2026.01.15-rc3" },
    "capabilities": { "platformName": "Android", "appium:deviceName": "Pixel 7", "appium:app": "s3://builds/checkout-rc3.apk", "appium:automationName": "UiAutomator2" },
    "verdict": "REAL_REGRESSION",
    "confidence": 0.92,
    "failureClass": "lifecycle",
    "evidence": [
      { "id": "ev-5a6b7c8d", "kind": "screenshot",
        "location": ".theqa/artifacts/run-2026-01-15/tests_mobile_checkout/screenshot.png",
        "summary": "Coupon field empty after background/kill + relaunch; restoration state lost",
        "collectedAt": "2026-01-15T15:22:00Z", "label": "OBSERVED" },
      { "id": "ev-6b7c8d9e", "kind": "log_line",
        "location": ".theqa/artifacts/run-2026-01-15/tests_mobile_checkout/console.log",
        "summary": "Appium server log excerpt (session id, caps echoed); tokens scrubbed",
        "collectedAt": "2026-01-15T15:22:10Z", "label": "OBSERVED" }
    ],
    "assumptions": ["device pool isolated for this run", "app build pinned per capability input"]
  },
  "label": "OBSERVED"
}
```

## Examples

**Walkthrough 1 — lifecycle regression on a real device cell.** The coupon state is lost after background/kill + relaunch on the Pixel 7 / Android 14 cell; the spec asserts restoration as an explicit lifecycle step (rule 6), fails deterministically, and the bundle carries the screenshot plus metadata.device. The import closure ties the spec to the changed state-persistence module → REAL_REGRESSION at 0.92. The fix is verified by re-running the SAME cell to green (rule 10) — the emulator cell alone would not have closed it, because the failure class was lifecycle-on-device.

**Walkthrough 2 — vendor-neutral farm introduction.** A team needs iOS coverage their CI lacks. The skill keeps `AppiumCapabilityInput` as the contract, sets `platformName: 'iOS'`, `appium:automationName: 'XCUITest'`, and passes farm-specific settings only via `extra` (namespaced automatically). The farm run is classified HIGH_RISK (`external.systems`), confirmed with `--confirm-risk`, and the farm's JUnit output parses through the same adapter. When the farm bill or vendor quality disappoints, the neutral input means switching vendors is a config change, not a test rewrite — the tests never learned the vendor's name.

## Verification checklist

- [ ] Capabilities were expressed through the neutral input; vendor extras stayed under `appium:` namespacing.
- [ ] The device matrix is documented with the real-vs-emulator split and the reasoning behind it.
- [ ] Every failure bundle identifies the matrix cell (device, OS version, app build).
- [ ] Permissions, interrupts, and lifecycle steps are scripted state-machine steps, not accidents.
- [ ] Hybrid screens switch contexts explicitly and assert within one context at a time.
- [ ] Waits target real state; no sleeps, no coordinate taps where an element exists.
- [ ] Farm runs were confirmed with `--confirm-risk` and used env-backed credentials.
- [ ] Cells that never ran are reported NOT_RUN with reasons — no borrowed coverage.
- [ ] Biometric-gated paths are simulated states or honestly NOT_RUN on CI.
- [ ] Keyboard-sensitive flows disable predictive input and assert on values, not keystroke paths.
