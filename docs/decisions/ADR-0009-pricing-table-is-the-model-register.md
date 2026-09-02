# ADR-0009: The pricing table is the model register; a priced figure is derived, never stored authoritatively

- **Status:** proposed
- **Date:** 2026-07-28
- **Discussion:** https://github.com/dezeat/claude-usage-meter/discussions/149
- **Supersedes on acceptance:** ADR-0004's persisted-cost authority; its
  live-payload rule is restated and retained below

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

### Authority and the surviving ADR-0004 rule

**1. Token facts are persisted; token-backed cost is always derived from the
current register.** For every row with a valid token ledger, `tokens_json` is
the authority and all surfaces calculate cost at read time against the current
register. `cost_usd` may remain as a disposable cache during migration, but it
must not be read when a valid token ledger exists. A pricing change therefore
reprices historical token-backed rows immediately; no table version is stored
per row.

On acceptance, this rule **supersedes ADR-0004's statements that the
write-time pricing calculation persisted in `row.costUsd` is authoritative for
stored rows or wins merely because a store row exists**. ADR-0004 remains the
historical record and is not edited. Its other authority rule survives exactly:
`payload.cost.total_cost_usd` is authoritative only for the live session when
that session has no indexed token ledger yet. The payload cost is never written
into or summed with a persisted aggregate. Once a valid token ledger exists,
the current-register calculation wins over both payload cost and `cost_usd`.

### Canonical model and pricing register

**2. `pricing/models.json` is the sole, language-neutral register artifact.** It
is UTF-8 JSON with this version-1 shape (shown with one illustrative entry):

```json
{
  "schemaVersion": 1,
  "asOf": "2026-07-22",
  "models": [
    {
      "id": "claude-opus-4-8",
      "class": "opus",
      "standard": {
        "inputUsdPerMTok": "5",
        "outputUsdPerMTok": "25"
      },
      "fast": {
        "inputUsdPerMTok": "30",
        "outputUsdPerMTok": "150"
      }
    }
  ]
}
```

The contract is exact:

- `schemaVersion` is the integer `1`. Unknown versions fail validation.
- `asOf` is a real UTC calendar date in `YYYY-MM-DD`. It advances whenever a
  model, class, standard rate, or fast rate changes; a no-op never changes it.
- `models` is an array sorted bytewise ascending by `id`, with no duplicate
  IDs. `id` is the canonical dateless Claude model alias; dated transcript IDs
  continue to normalize to it before lookup.
- `class` is a required lower-case ASCII identifier used for rollups. It is
  data, not inferred from `id`; every model has exactly one class, and adding a
  new class is an explicit reviewed register change.
- `standard` is required and `fast` is optional. Each contains exactly
  `inputUsdPerMTok` and `outputUsdPerMTok`, in that order. Values are positive
  base-10 decimal strings denoting USD per one million tokens, with at most six
  fractional digits, no exponent, sign, separator, or redundant trailing zero.
  Readers parse them into integer micro-USD per MTok before arithmetic; JSON
  binary floating-point is never the interchange authority.
- For each present tier, 5-minute cache creation is derived as `input × 1.25`
  and cache read/refresh as `input × 0.1`, exactly in integer micro-USD. The
  meter has no token fact that distinguishes a 1-hour cache creation, so that
  rate is not represented or guessed. A value whose derived rates are not exact
  micro-USD fails validation.
- Promotional, regional/data-residency, batch, priority, and other feature
  prices are outside schema version 1. The watcher may neither map them onto
  `standard` nor add them as fields. It updates only observed standard base
  rates and preserves every existing `class`, optional `fast`, and other
  non-target entry unchanged. Fast rates remain manually reviewed until a
  later decision gives the watcher an authoritative fast-price source.

`DEFAULT_PRICING` ceases to be an independently hand-authored register.
`modelClass()` becomes a lookup against the generated table; an unknown ID may
still use its existing best-effort display fallback, but it is unpriced and is
never admitted as a known class. A gate test asserts every priced model has a
registered class.

### Deterministic generation and watcher patch contract

**3. The JSON artifact generates the TypeScript consumer; generated code is not
edited independently.** A zero-runtime-dependency repository command,
`npm run generate:pricing`, validates the complete JSON and deterministically
renders `src/generated/pricing-register.ts`. That module exports the typed
register literal consumed by `src/pricing.ts`; the normal build emits its
runtime counterpart at `dist/generated/pricing-register.js`. Both generated
files are committed. `npm run generate:pricing -- --check` is part of the full
gate and fails on schema errors, non-canonical ordering/decimals, or drift
between JSON and generated TypeScript. The standard build then proves `dist/`
is synchronized.

Generation first parses and validates the entire artifact, derives all cache
rates, and renders every output in memory. Only then may it replace generated
files. A validation or rendering failure writes nothing. The pricing watcher
uses the same contract: apply the standard-rate and `asOf` change to an in-memory
copy, preserve non-target fields, validate and generate, run the complete meter
gate, and place the canonical JSON plus all generated outputs in one Git commit.
Failure at any stage produces no pricing commit. Re-running the same observation
must produce the same bytes and an empty diff.

### Token tiers, unknown speed, and legacy rows

**4. Speed is persisted with the tokens it priced.** `tokens_json` moves to a
versioned ledger whose logical shape is:

```json
{
  "version": 2,
  "models": {
    "claude-opus-4-8": {
      "standard": {
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "cacheCreationTokens": 0
      },
      "fast": {
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "cacheCreationTokens": 0
      },
      "unknown": {
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "cacheCreationTokens": 0
      }
    }
  }
}
```

Zero buckets may be omitted, but present counts are finite non-negative integer
token counts and the semantic result is independent of object-key order.
Deduplication occurs before attribution, as today. For each assistant usage
record, `usage.speed === "fast"` selects `fast`; an absent, null, empty, or
literal `"standard"` value selects `standard` for backward compatibility. Any
other value selects `unknown` and is preserved there rather than guessed into a
priced tier. Unknown model IDs are likewise preserved under their observed tier.

Standard tokens use `standard` rates. Fast tokens use `fast` only when that
model declares it. Unknown-tier tokens, unknown models, and fast tokens for a
model without fast rates contribute `$0`, set the existing unpriced signal, and
remain in token totals. They never fall back to standard pricing. The identity
row shows a dim `fast` marker only when the latest assistant turn explicitly
said `fast`; `standard` and `unknown` are not rendered. ADR-0007's width priority
still makes the marker sheddable.

**5. Legacy rows have an explicit, non-destructive fallback.** A row with
`tokens_json = NULL` and `byte_offset = 0` is the existing heartbeat-only
skeleton: it has no usage or cost and is not a priced legacy row. A row with
`tokens_json = NULL` and `byte_offset > 0` is a meaningful pre-ledger row whose
tokens cannot be reconstructed from the database. Until it is rebuilt,
`cost_usd` is retained as a labelled **legacy frozen fallback** for that row only;
it participates in existing aggregates but is not claimed to reflect the
current register. It must not be replaced with `$0`, synthetic tokens, or an
inferred tier.

There is no lossy SQL migration. When the original transcript is available, a
full re-index from byte offset zero atomically writes the version-2 token ledger
and thereafter the row uses current-register derivation; the legacy fallback is
no longer read. If the transcript is absent, unreadable, or malformed, the row
keeps its frozen fallback and is reported as legacy until a successful rebuild.
Existing non-null unversioned token objects are interpreted as version-1
standard-tier ledgers and rewritten to version 2 on their next successful
transcript upsert; they are already repriceable and never fall back to
`cost_usd`.

## Consequences

- A new model is one edit in one file: its rates, its class, and its tiers. That
  is what makes an automated rate-change PR reviewable — and it is the claim
  dezeat/bridge#94 rests on, which today does not hold.
- Pricing-table staleness stops being a state for token-backed rows. There is no
  table-version column or repricing job: #146 removes their write-time authority
  and computes at read. The separately labelled frozen fallback for irrecoverable
  pre-ledger rows is migration debt, not a current-table price. #144 otherwise
  collapses to the single `unpriced` signal defined above.
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
- The canonical JSON and generated TypeScript/JavaScript add committed artifacts,
  but their drift is mechanically gated and one atomic commit remains the review
  unit. The watcher can patch data without parsing TypeScript or assigning a
  class, while the meter remains zero-network and zero-runtime-dependency.
- Unknown speed remains observable instead of being silently billed at standard;
  this may temporarily understate dollars, but it cannot fabricate a price and
  the persisted tokens remain recoverable when the register or parser is updated.
