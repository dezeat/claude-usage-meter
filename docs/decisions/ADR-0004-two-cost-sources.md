# ADR-0004: Two cost sources — payload cost for the live session, pricing-table calc for everything persisted

- **Status:** accepted
- **Date:** 2026-06-15
- **Discussion:** https://github.com/dezeat/claude-usage-meter/discussions/47

## Context

A session's dollar figure can come from two places, and they do not always
agree:

- The statusline **payload** carries `cost.total_cost_usd` (`payload.ts`,
  `ParsedPayload.costUsd`) — Claude Code's own running total for the current
  session. It is available the instant the statusline renders, before the
  session's transcript has been folded into the store.
- The **pricing-table calc** (`pricing.ts` `cost()` over aggregated tokens,
  persisted as `row.costUsd` by `index-store.ts`) is what every stored figure is
  built from — per-session, month, the fleet `Σ`, and the off-session report.

These are different numbers: the payload is Claude Code's accounting; the
pricing-table calc is ours, reconciled against ccusage and our hand-maintained
rate table (`asOf`). Mixing them — say, summing a payload cost into a month total
that is otherwise pricing-table-derived — would produce a figure that
reconciles against neither oracle, and an unknown model (priced `$0`, excluded)
would silently disagree with the payload that still counts it.

## Decision

There is exactly one authority per scope:

- The **payload** `cost.total_cost_usd` is authoritative **only** for the
  **live, not-yet-indexed** session — the `ses` cost-only fallback in
  `render.ts` (no store this render) and in `fleet-render.ts`'s `renderSpend`
  (the session has no store row yet). It is never summed into any aggregate.
- The **pricing-table calc** over aggregated tokens is authoritative for
  **everything persisted**: the indexed `ses` cell, cross-session totals, the
  month spend, the fleet `Σ`, and the report. Once a session has a store row, its
  pricing-table cost wins over the payload — `renderSpend` picks the store row
  first and only falls back to the payload when no row exists yet.

## Consequences

- Every aggregate (`Σ`, month, report) is internally consistent and reconciles
  against the same oracle (ccusage + the `asOf` table); a payload figure never
  leaks into a sum.
- The live `ses` cell can briefly differ from the eventual persisted figure for
  the same session — by design: it is the freshest number available before the
  fold, replaced by the pricing-table figure on the next render after indexing.
- An unknown model contributes `$0` to persisted totals (never guessed); the
  payload may still count it, which is the price of having a fast pre-index
  number and is contained to the single live cell.
- The boundary is documented in-code by pointer comments at the two sources
  (`payload.ts` `costUsd`, `index-store.ts` `upsertTranscript`) and the picker
  (`fleet-render.ts` `renderSpend`).
