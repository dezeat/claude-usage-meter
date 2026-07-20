# ADR-0008: Refresh heartbeats define live sessions

- **Status:** accepted
- **Date:** 2026-07-20
- **Discussion:** https://github.com/dezeat/claude-usage-meter/issues/118

## Context

Transcript `lastTs` is event time, not proof that a Claude Code session is still
running. A five-minute liveness window hid quiet-session flicker but kept closed
sessions in the fleet roster for up to five minutes. Shrinking that window alone
would make active sessions disappear between turns because quiet statusline ticks
previously wrote nothing.

The alternatives are a process probe, a session-end signal, or a wall-clock
heartbeat. Claude Code exposes neither a reliable process identity nor a session-end
event to the statusline. A heartbeat adds one small write per refresh, trading the
old zero transcript/sweep-write tick for prompt and stable liveness.

## Decision

Each statusline tick may atomically insert a minimal top-level session row with its
required path/defaults, or update only that row's nullable `heartbeat_ms` with the
wall clock captured at the statusline edge. The conflict update is monotonic,
single-row, and single-column; it must never overwrite transcript offsets, tokens,
cost, branch, model, or subagent rows. Failures are swallowed so rendering can
continue with stored data.

Liveness uses `heartbeat_ms` first and falls back to `lastTs` only until a row has
its first heartbeat. A session is live while `nowMs - livenessTs < windowMs`; the
exact boundary is expired. The window is three refresh ticks: 30 seconds for Claude
Code's 10-second default. Because Claude Code does not include `refreshInterval` on
statusline stdin, a non-default command mirrors its seconds value through
`USAGE_METER_REFRESH_INTERVAL`. Pure rendering and SQL use the same policy and keep
excluding the current session and subagent rows.

The H1 quiet-tick invariant is narrowed: the cross-project sweep and transcript
fold perform zero upserts when nothing grew; the one heartbeat update is the sole
**new** per-tick write introduced by this decision. Pre-existing account-limit LWW
upserts may still run when the payload carries 5h/7d observations.

## Consequences

- Joins appear on another session's next refresh, and departures age out after
  three configured refresh ticks instead of five minutes.
- Quiet active sessions stay present independently of transcript growth.
- A minimal heartbeat-only row is liveness evidence, not transcript spend
  authority; ADR-0004's live payload fallback remains in force until a complete
  transcript line is indexed.
- Legacy and Stop-hook-only rows degrade through `lastTs` and naturally age out.
- Every statusline refresh now takes one short WAL write lock for its own row.
- Custom `refreshInterval` configurations must mirror the value in the command
  environment until Claude Code exposes it to statusline processes.
