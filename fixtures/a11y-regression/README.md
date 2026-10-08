# a11y-regression — icon button loses its accessible name (triage: SELECTOR_FAILURE)

NimbusDesk's gear control in the workspace settings header is reachable by
its accessible name "Open settings". The change under test is an API tidy:
`IconButton` renames `ariaLabel` to `label` and — in the same refactor —
stops forwarding the name to `aria-label` on the rendered button (only the
visual `title` tooltip survives).

Planted defect: `app/ui/icon-button.tsx` renders without `aria-label`, and
`app/web/settings-page.tsx` flips to the renamed prop; the accessible name
of the gear button disappears.

The human observes: both a11y specs fail with a locator timeout waiting for
`getByLabel('Open settings')` on two consecutive attempts (previously green
on four runs). The renamed prop line carrying the "Open settings" literal
is part of the diff, so the accessible-name literal the test targets is
visible in the change set — a selector contract break, not silent product
behavior loss.
