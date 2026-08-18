# ADR-0009: The pricing table is the model register; a priced figure is derived, never stored authoritatively

- **Status:** proposed
- **Date:** 2026-07-28
- **Discussion:** https://github.com/dezeat/claude-usage-meter/discussions/149

## Context

Three open tickets — speed-tier pricing (#143), repricing rows written under an
older table (#146), and a bot that patches rates automatically
(dezeat/bridge#94) — all mutate the same two things: the shape of
`PricingTable`, and the relationship between a priced row and the table that
priced it. Taken one at a time, that relationship gets designed two or three
times.

Three findings force the decision:

- **The table is not the only model register.** `modelClass()`
  (`index-store.ts`) carries a second, independent list — `["opus", "sonnet",
"haiku", "fable"]` — matched by substring against the model id. A new member of
  an existing family self-registers (`claude-opus-6` → `opus`); a new _family_
  does not, and the miss is silent, returning the raw model id as the class. This
  has already drifted: `claude-mythos-5` is priced but resolves to the class
  `claude-mythos-5`, so it would land in the by-class rollup as its own row and
  scope spend and fleet by that string.
- **A persisted cost never gets revisited.** `upsertTranscript()` returns early
  when a transcript has no new bytes, so a finished session keeps the figure the
  table produced at index time. Measured on the live index, that is **+$63.89 on
  $2,505.63 (2.5%)** of understatement carried forward (#146). ADR-0004 decided
  _which source_ is authoritative but never what happens when that source changes
  afterwards.
- **Speed is not in the payload.** The statusline payload carries only
  `model.id` and `model.display_name`; `usage.speed` on the transcript's
  assistant turns is the only source. The fold already reads `usage` for token
  counts, so pricing by speed and displaying the active speed are one change, not
  two.

The alternative to a table-shaped register — deriving class and tier from the
model id by pattern — is what the code does today, and it is exactly what failed
silently for Mythos.

## Decision

**1. `DEFAULT_PRICING.rates` is the single register of known models.** Every
model the tool recognises appears there exactly once, keyed by its dateless
model id, and each entry declares its class alongside its rates. `modelClass()`
becomes a lookup against the table; the substring match survives only as the
fallback for an id the table has never seen. A gate test asserts that every
priced model resolves to a known class — no priced model may be classless.

**2. Rates are declared as data, not assembled by helper calls.** An entry
states its numbers (or its tier by name) in a form that can be rewritten by a
tool without inferring which family a new model belongs to. This is a
prerequisite for dezeat/bridge#94, not a style preference.

**3. Speed is a dimension of an entry, not a separate model.** An entry may
carry a `fast` variant beside its `standard` rates; absent means the model does
not offer that tier. Speed is folded from `usage.speed` on the assistant turn
that produced the tokens, and tokens are attributed to the tier that billed
them.

**4. A cost figure is derived from stored tokens and the current table — it is
never a stored source of truth.** `tokens_json` is the persisted state; any
`cost_usd` alongside it is a cache with no authority, and every surface computes
from the current table at read time. This **amends ADR-0004**: its rule that the
pricing-table calc beats the payload for everything persisted stands unchanged;
what changes is that "the pricing-table calc" means _the current_ table, not the
one that happened to be loaded when the row was written.

**5. The active speed tier is shown only when it is not standard.** A dim marker
in the identity row, sheddable under ADR-0007's width priority, reflecting the
latest assistant turn — consistent with that row already showing the live model.
"standard" is never rendered.

## Consequences

- A new model is one edit in one file: its rates, its class, and its tiers. That
  is what makes an automated rate-change PR reviewable — and it is the claim
  dezeat/bridge#94 rests on, which today does not hold.
- Staleness stops being a state that can exist. There is no "priced under an old
  table" row to detect, migrate, or reprice, and no schema column recording which
  table priced what. #146 becomes: delete the write-time authority, compute at
  read. Correspondingly, #144 collapses to a single `unpriced` marker, because
  `stale` ceases to be a thing the surface can encounter.
- The store loses independent auditability. "What did we bill this row at, under
  which table" is no longer answerable from the row alone — it is always the
  answer the current table gives. The trade is deliberate: a figure that silently
  disagrees with the table is worse than one that cannot be reconstructed
  historically.
- Read-time cost is real but measured, not assumed: repricing is a handful of
  multiplications per model per row over data already read into memory, against a
  statusline tick that is ~0.22s and dominated by Node cold start (#128). If a
  future roster makes that false, the answer is a memoised recompute keyed on the
  table's `asOf`, not a return to write-time authority.
- Classless models become impossible to ship — the gate test fails rather than a
  rollup quietly growing a row named after a model id.
- The register grows a second axis (tier). A model with no `fast` entry that is
  later offered in fast mode is a table edit, not a code change, which is the
  point.
