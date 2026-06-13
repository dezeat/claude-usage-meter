# ADR-0003: Sessions self-persist via a targeted write on a dedicated Stop hook

- **Status:** accepted
- **Date:** 2026-06-14
- **Discussion:** https://github.com/dezeat/claude-usage-meter/discussions/26

## Context

The store is written only by `updateIndex`, which runs from `statusline.ts` on each
refresh and sweeps **every** project. A session whose statusline is not ticking (or
not installed) never persists itself, so other sessions' fleet views miss it. The
goal of #15 is to make the **writes** event-driven so the store stays fresh; we
cannot push a refresh into another session (Claude Code drives each statusline's
refresh on its own interval).

Options weighed:

- **Event:** `PostToolUse` fires after every tool call — constant mid-turn writes
  for negligible gain, since other sessions only repaint on their own interval.
  `SubagentStop` is unnecessary — a subagent runs inside the parent's turn, so the
  parent's `Stop` already fires after the children's files exist.
- **Scope:** reusing the full cross-project `updateIndex` on `Stop` re-`readdir`s
  every project on every turn-end and duplicates what the statusline already does.
- **Placement:** folding the write into `summary-hook.ts` couples the display path
  to the write path and lets one failure suppress the other.

## Decision

On the **`Stop`** event only, a **separate `index-hook.ts`** entrypoint (a second
`Stop` hook in the plugin's `hooks.json`, failure-isolated, never throws) calls a
**targeted** `updateSession(indexPath, transcriptPath, pricing)` that incrementally
folds **only the current session's files** with the same atomic per-row upserts.

This decouples "persist myself" (cheap, event-driven, on every turn-end) from "read
the whole fleet" (the statusline's full sweep, unchanged).

## Consequences

- A session persists itself on every turn-end whether or not it has a statusline, so
  other sessions' statuslines see it on their next tick.
- The `Stop` write stays cheap — one session's files, not a cross-project sweep.
- `updateSession` is the single place subagent folding is added in #16 (N8), so N6
  and N8 compose there.
- One extra short-lived `node` spawn per turn-end (human cadence) — negligible.
- The hook must swallow all errors and exit 0, like `summary-hook.ts`; a failed
  write must never block the session.
