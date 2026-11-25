# ADR-0011: Tiers may declare an exact cache-read rate

- **Status:** accepted
- **Date:** 2026-09-08
- **Decision:** https://github.com/dezeat/claude-usage-meter/issues/174
- **Supersedes:** ADR-0009's register schema version and fixed cache-read
  derivation only; all its other rules remain in force

## Context

The published Fable 5.1 standard rates are $10/MTok input, $50/MTok output,
$0.25/MTok cache reads, and $12.50/MTok 5-minute cache writes
([pricing source](https://platform.claude.com/docs/en/about-claude/pricing),
verified 2026-09-08). A fixed input × 0.1 rule cannot represent that cache-read
price. The maintainer approved exact-rate support in #174.

## Decision

`pricing/models.json` requires integer `schemaVersion: 2`; every other version
fails validation. Each `standard` or optional `fast` tier has these canonical
keys, in order:

```json
{
  "inputUsdPerMTok": "10",
  "outputUsdPerMTok": "50",
  "cacheReadUsdPerMTok": "0.25"
}
```

`cacheReadUsdPerMTok` is optional. When present, it is the exact cache-read rate;
when omitted, cache reads retain the input × 0.1 derivation. An explicit rate
uses the existing canonical positive decimal-string contract: at most six
fractional digits, no redundant trailing zeros, signs, exponents, or separators,
exact integer micro-USD parsing, and an exact micro-USD round trip through the
runtime number representation. Unknown fields and noncanonical order fail.

5-minute cache creation remains input × 1.25. Every rate actually used must be
exactly representable in micro-USD, including derived writes and omitted reads.
An explicit read does not require the unused input × 0.1 result to be exact.
No 1-hour creation rate or token distinction is added.

Generation validates and renders the entire register before any output write.
The optional field flows into the existing generated `cacheReadPerMTok` rate
and the existing token-cost calculation. Generated TypeScript and committed
JavaScript remain deterministic and drift-gated.

The structural migration changes only `schemaVersion` in the canonical data.
It preserves all models, classes, tier values, and `asOf`, and produces unchanged
runtime rates. Populating a new model or changing a price remains a separate,
reviewed monetary change with verified provenance and its corresponding `asOf`.

## Consequences

Exact published prices can be represented without hard-coded model exceptions
or a second multiplier field. Omitted rates preserve existing behavior. All
register producers and validators must move to schema version 2 together;
version 1 input is intentionally rejected. Runtime dependencies, networking,
and unsupported feature prices remain outside the contract.
