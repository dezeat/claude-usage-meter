# Decision records (ADRs)

Binding architecture and process decisions live here as short **ADRs** — the one
class of narrative doc that stays in the repo, because an implementing agent must
read the decision in its context window while coding. The long-form rationale and
debate live in a `Decisions` GitHub **Discussion**; the ADR is the crystallized,
binding constraint.

## When to record one

Only when **all three** hold:

1. **Hard to reverse** — undoing it later is costly or disruptive.
2. **Surprising without context** — a newcomer would not guess it from the code.
3. **A real trade-off** — a credible alternative was rejected for stated reasons.

A formatting tweak or an obvious choice is not an ADR. When in doubt, leave it out
and let the code speak.

## Format

One file per decision: `ADR-NNNN-<kebab-slug>.md`, `NNNN` zero-padded and
monotonic.

```
# ADR-0001: <title>

- **Status:** accepted | proposed | superseded by ADR-NNNN
- **Date:** YYYY-MM-DD
- **Discussion:** <link to the Decisions Discussion thread>

## Context
What forces this decision — the constraint, the problem, the options.

## Decision
The choice, stated as a binding rule an implementer must follow.

## Consequences
What this makes easy, what it makes hard, what it rules out.
```

## Changing a decision

Never edit an accepted ADR. Add a new one that supersedes it: set the new ADR's
status to `accepted` and the old one's to `superseded by ADR-NNNN`. The trail is
the point.
