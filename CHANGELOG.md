# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
From the next release onward, entries below are generated from
[Conventional Commits](https://www.conventionalcommits.org/) by release-please.

## [0.1.0] - 2026-06-14

Initial public release.

### Added

- Live three-row statusline rendered from the Claude Code payload on stdin: a
  `limits` row with context, 5-hour, and 7-day pace bars and reset countdowns; a
  cost-forward `spend` row (session, active model class, month total); and a
  cross-session `fleet` row of per-class session counts and live-now markers.
- After-task cost summary `Stop` hook printing a per-model token and dollar
  breakdown for the task that just finished.
- Off-session report CLI: a retrospective dashboard across every project session
  with per-day usage, per-model-class and per-branch totals, and a billing-period
  total.
- Cross-session index in the Node built-in `node:sqlite` at
  `~/.claude/usage-meter/index.db`, one row per transcript keyed by byte offset so
  each line is counted exactly once.
- Event-based DB writes: an `index-hook` `Stop` hook self-persists the current
  session (including its subagents) on every turn-end, so other live sessions see
  it on their next refresh.
- Subagent token attribution: a subagent's cost rolls into the parent session's
  total while its spend stays priced under the subagent's own model class, and
  session counts tally only top-level sessions.
- Hand-maintained, zero-network pricing table with a visible `asOf` date, dateless
  model aliases with `-YYYYMMDD` snapshot normalization, and legacy Opus 4.0/4.1
  rates; unknown models cost `$0`, are flagged, and are excluded from the total
  rather than guessed.
- `NO_COLOR` support: the glyph layout and every field survive with the hue layer
  dropped.
- Single-plugin marketplace manifest so the plugin installs via
  `/plugin marketplace add` and activates both `Stop` hooks.
- Committed `dist/` as the runnable artifact, so a clone runs with no build step.

### Requirements

- Node.js >= 22.13 (unflagged `node:sqlite`). No runtime dependencies.

[0.1.0]: https://github.com/dezeat/claude-usage-meter/releases/tag/v0.1.0
