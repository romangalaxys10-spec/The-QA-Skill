# false-positive — a search suite that cannot fail (quality: 67/100)

FindIt's catalog search suite is green on every run — and proves nothing.
Both cases in `tests/search.test.ts` fire the engine, log the hits to the
console, and end without a single assertion (one even sleeps 120ms "to let
the index warm"). In the same change set, synonym expansion in
`app/search/engine.ts` learned a fatal short-circuit: any expanded term
with no postings (`table`, `station`, `rug`, `pad` are not in this catalog)
aborts the query, so every multi-word search now silently returns zero
results.

Planted defect: `app/search/engine.ts` returns `[]` for
`search('desk mat')` while `tests/search.test.ts` reports success — the
suite passes over a user-visible regression because it cannot fail.

The human observes: CI green on the very commit that broke multi-word
search; the suite only looks like coverage. The manual repro record in
failures.json is what a customer found first.
