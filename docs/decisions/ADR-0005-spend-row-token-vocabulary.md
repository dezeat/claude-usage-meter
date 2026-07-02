# ADR-0005: Spend-row token vocabulary — i|c|o, cache writes count as input

- **Status:** accepted
- **Date:** 2026-07-02
- **Discussion:** https://github.com/dezeat/claude-usage-meter/discussions/82

## Context

The statusline spend row differentiates its dim token trail into a compact keyed
form across all three cells (`ses`, `mdl`, `Σ`). The API bills four token kinds:
uncached input, cache reads (~0.1× the input rate), cache creation (1.25×), and
output. A three-key display must fold cache creation somewhere, and where it
folds changes what `c` means at a glance. Alternatives considered: `c` = all
cache traffic (mixes the 0.1× reads with the 1.25× writes, so `c` stops
explaining why dollars sit far below tokens), and an exact four-key `i|o|r|w`
(rejected for width — the split renders in all three cells).

## Decision

- The spend-row token trail is **`i:<n>|c:<n>|o:<n>`** in that order — input-side
  buckets first (fresh, then cached), output last. Values via `humanTokens`,
  rendered dim; pipes separate segments inside a cell so `·` stays the
  unambiguous cell separator.
- **`c` is cache reads only.** Cache-creation tokens fold into `i` — they are
  fresh input work billed above the base input rate, not cached savings.
- Invariant: `i + c + o` equals the four-way total the trail displayed before
  the split.
- The verbose four-way (`in … · out … · cache … r / … w`) remains the vocabulary
  of the report CLI and the Stop summary; the shorthand is a statusline width
  concession, not a house-wide rename.

## Consequences

- `c` stays aligned with the `% cache reads` legibility cue: the cheap bucket
  explains the cost. A cache-write burst surfaces in `i`, where its cost
  actually lands.
- `ses`, `mdl`, and `Σ` share one vocabulary; the live not-yet-indexed session
  still renders cost-only (ADR-0004 — the payload carries no token split), so
  the trail appears with the first fold.
- Rules out silently re-folding writes into `c` later; changing the fold is a
  new ADR superseding this one.
