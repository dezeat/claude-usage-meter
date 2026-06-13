# ADR-0002: Subagent per-class spend follows the real model; session rollup credits the parent

- **Status:** accepted
- **Date:** 2026-06-14
- **Discussion:** https://github.com/dezeat/claude-usage-meter/discussions/26

## Context

A subagent can run a different model than its parent — e.g. a Haiku subagent under
an Opus parent. Its tokens are real Haiku tokens, billed at Haiku rates. "Credit
subagent tokens to the parent session" (#16) is ambiguous: does the child's spend
appear under the **parent's** model class (Opus) or its **own** (Haiku)?

## Decision

Per-class rollups (`monthClassSpend`, the spend row's per-class cells) attribute a
child's tokens to **its own actual model class**. The child row keeps its real
`model_class`, so it lands under Haiku.

"Credit to the parent **session**" applies to the **session-level** rollup only: a
session's totals — the `ses` cell and "which session owns the work" — sum the parent
and its children via `COALESCE(parent_session_id, session_id)`.

## Consequences

- Per-class cost stays truthful to what was billed; a price is never relabeled onto
  the wrong model (consistent with the pricing-truthfulness rule in CLAUDE.md).
- The parent session's `ses` total includes its subagents' cost.
- Accepted asymmetry: the fleet **count** can show `0` haiku **sessions** while the
  spend row shows nonzero haiku **spend** (a subagent produced Haiku cost but is not
  itself a session). This is correct, not a bug.
