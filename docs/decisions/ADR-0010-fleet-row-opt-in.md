# ADR-0010: The fleet row is opt-in — `USAGE_METER_FLEET`

- **Status:** accepted
- **Date:** 2026-09-02
- **Discussion:** https://github.com/dezeat/claude-usage-meter/issues/164

## Context

The block layout rendered four rows by default: `current`, `limits`, `spend`,
`fleet`. The fleet row (month session counts + live roster) earns its place
during parallel worktree work, but for the far more common single-session use it
is persistent noise on a line read dozens of times an hour — #164 recorded the
product question. Options considered: keep four rows (rejected — the everyday
readout should be session-and-spend only), delete the row and its renderer
(rejected — the parallel-work use case is real and the data is already
computed), or move it behind a toggle like the ADR-0007 presentation toggles.

## Decision

The fleet row is **hidden by default** and opt-in via a third ADR-0007-style
env toggle, read at the I/O edge and passed into the pure `renderLine` as a
`fleet` option:

- **`USAGE_METER_FLEET`** = unset/other (**default** — no fleet row) | `on`
  (the row renders as before).

Binding constraints this records:

1. **One flag, both layouts.** The toggle hides the fleet row in the block
   layout and the count/roster segments in the `line` HUD alike — fleet
   visibility is one concept, not a per-layout setting.
2. **Visibility only, never accounting.** The toggle gates rendering; the index
   still folds every session, heartbeats still write, and the off-session
   report and `Stop` summary keep their fleet/per-class figures. Turning the
   row on shows data that was maintained all along.
3. **The spend row is untouched.** The `Σ` month ledger and cache share belong
   to `spend` and stay in the default look.
4. **Pure-core default is the historical shape.** `renderLine` defaults
   `fleet: true` (existing tests and callers keep the four-row shape); the
   product default (hidden) is resolved at the edge, exactly like ADR-0007's
   toggles.

## Consequences

- The default block is three rows; parallel-work users set
  `USAGE_METER_FLEET=on` in the statusline `command` to get the roster back.
- The HUD's `DROP` table keeps its roster/count slots — with the toggle off the
  segments are simply never built.
- Removing the fleet renderer or moving fleet data out of the index is a new
  ADR superseding this one.

Reference: #164.
