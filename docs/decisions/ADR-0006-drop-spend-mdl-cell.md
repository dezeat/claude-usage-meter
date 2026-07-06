# ADR-0006: Drop the spend row's per-class month cost cell (`mdl $…`)

- **Status:** accepted
- **Date:** 2026-07-06
- **Discussion:** https://github.com/dezeat/claude-usage-meter/issues/92

## Context

The statusline spend row rendered three cost cells: `ses` (live session), `mdl`
(this-model-this-month), and `Σ` (month total). Each cell then gained the
ADR-0005 `i|c|o` token trail, widening every one of them — the compounding made
spend the widest row on the statusline. `Σ` already carries the month total, so
`mdl $` was the only _per-class_ month cost on the line. That figure is
reference-cadence data — checked occasionally to compare models — not
glance-cadence data the live line exists to surface. Options considered: keep all
three cells (rejected — spend stays the widest row for a number rarely read at a
glance), or drop the per-class month cost from the live line and serve it where
per-model breakdowns already live.

## Decision

- The spend row's `mdl $…` per-class month cost cell is **dropped**. The spend
  row renders `ses` (live) and `Σ` (month total) only.
- Per-model month cost breakdown is **the report CLI's job** — that is the home
  for reference-cadence analysis, off the fast render path.
- This decision is scoped to the spend row's _cost_ cell only. The fleet row
  keeps its own `mdl <count> Σ <total>` cell, which is a session-count summary,
  not a per-class month cost — untouched here.

## Consequences

- The spend row narrows; the widest-row pressure from ADR-0005's trail eases
  without touching the trail itself.
- Comparing month cost across models moves to an explicit CLI invocation instead
  of a passive glance — a deliberate trade of ambient visibility for a narrower
  live line.
- No conflict with ADR-0005: that ADR fixes the trail _vocabulary_ (`i|c|o` and
  what `c` means), not _which cells exist_. Dropping a cell leaves the remaining
  cells' trail vocabulary exactly as ADR-0005 defines it.
- Rules out reviving a per-class month cost cell on the spend row without a new
  ADR superseding this one.

Reference: #92, #86.
