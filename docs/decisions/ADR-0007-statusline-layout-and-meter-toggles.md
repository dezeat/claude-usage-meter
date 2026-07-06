# ADR-0007: Statusline layout and meter toggles — env-var presentation options

- **Status:** accepted
- **Date:** 2026-07-06
- **Discussion:** https://github.com/dezeat/claude-usage-meter/issues/86

## Context

The four stacked statusline rows are one presentation of the aggregated data, but
not the only sensible one: a compact single-line HUD suits a narrow prompt, and
severity chips read differently than bar glyphs. Rather than fork `renderLine`,
the choice is how to expose alternate presentations without a network call, a
runtime dependency, or a config-file parser. The repo already has a precedent:
`NO_COLOR` is read at the I/O edge and passed into the pure renderer as an
option. Options considered: a config file (rejected — adds a parse/throw path and
a schema to maintain, against the zero-deps and never-throw invariants), or
hard-coding one look (rejected — the trade-offs are real and user-specific).

## Decision

The statusline gains two orthogonal, composable presentation toggles. Both are
read at the I/O edge from environment variables and passed as options into the
pure `renderLine` — the pure core stays clock-free, `process`-free, and
env-free.

- **`USAGE_METER_LAYOUT`** = `block` (**default** — the four stacked rows) | `line`
  (a single-line HUD).
- **`USAGE_METER_METERS`** = `bar` (**default** — short bar glyphs) | `pill`
  (reverse-video severity chips).

Binding constraints this records:

1. **Env-var config, not a config file.** Zero new dependencies, no new
   parse/throw path, matching the `NO_COLOR` precedent. An unrecognized value
   degrades to the default; it never throws.
2. **The `line` HUD must never wrap.** It reads terminal width from the `COLUMNS`
   env var (Claude Code sets it, v2.1.153+; fallback `80`) and sheds fields
   against a fixed drop order — **trails → totals → labels** — until the line
   fits.
3. **`pill` meters degrade under `NO_COLOR`.** Pills encode severity in the
   background color, so with color off they MUST render as bracketed text —
   `[85%]` — where the value and shape survive and only the color ramp is lost.
   The glyph/layout layer stays a complete encoding; color is only a hue layer on
   top.

Defaults are chosen so the out-of-box look is `block` + `bar` — the four labelled
rows; the single-line HUD is one opt-in env var away.

## Consequences

- Two independent axes (2 × 2 = four looks) with no new config surface — a user
  opts in with an env var, exactly as they already do for `NO_COLOR`.
- The pure core gains two option fields and stays testable with fixed inputs; the
  edge owns the env reads.
- The `line` layout carries a width budget and a drop order — a new field added
  to the HUD must declare where it sits in that order, or it risks being the
  first thing shed.
- Rules out a config file for these toggles, and rules out a `pill` look that
  goes blank under `NO_COLOR`; changing either is a new ADR superseding this one.

Reference: #86.
