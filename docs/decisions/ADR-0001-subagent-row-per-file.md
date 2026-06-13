# ADR-0001: One store row per transcript file, with a parent_session_id link

- **Status:** accepted
- **Date:** 2026-06-14
- **Discussion:** https://github.com/dezeat/claude-usage-meter/discussions/26

## Context

The cross-session store keys one row by `session_id` (the transcript basename) and
tracks a single `byte_offset` per row. The "each assistant line is counted exactly
once" guarantee rests on **one offset advancing monotonically over one append-only
file** (see `foldLines` / `updateIndex`).

Claude Code writes subagent turns to **separate files** —
`~/.claude/projects/<project>/<PARENT_SESSION_ID>/subagents/agent-<hash>.jsonl`
(`isSidechain:true`, `sessionId` = the parent's id, normal `message.usage`). A
parent session therefore owns **N+1 independently-growing files** (its transcript
plus one per subagent). A single per-session offset can no longer describe that.

Alternative considered: keep one row per session and move offsets into a separate
`file_offsets(path → offset)` side table, folding every file into the one session
row. Rejected — it breaks the offset⟷file invariant and makes a single fold juggle
many files into one row, the prime place for missed or double-counted bytes.

## Decision

Store **one row per transcript file**. Each row is keyed by the file basename
(`<uuid>` for a top-level session, `agent-<hash>` for a subagent) and keeps its own
`byte_offset` — so the offset⟷file invariant and the existing incremental fold apply
to every file unchanged. A nullable `parent_session_id` column links a child row to
its parent (`NULL` for top-level).

- **Spend / tokens** roll children into the parent by `COALESCE(parent_session_id,
session_id)`.
- **Session count** and the **live `active ●` tally** count only top-level rows
  (`WHERE parent_session_id IS NULL`) — a subagent is not a user session.
- The `parent_session_id` is derived from the file **path** (the `<PARENT_SESSION_ID>`
  directory), not from reading the file.

## Consequences

- The incremental-correctness argument is preserved verbatim: one offset, one file.
- Concurrency stays free — parent and child rows are distinct primary keys, so the
  single-atomic-upsert-per-row property from #2 holds with no new work.
- The `session_id` column now means "transcript-file id": for child rows it holds an
  `agent-<hash>`, not a real session UUID. Read it as a file identity.
- Only two read paths gain a `parent_session_id IS NULL` guard (count, live); spend
  and per-session totals just sum more rows.
- Requires a schema migration (v1→v2) to add the column — see the build plan in the
  Discussion.
