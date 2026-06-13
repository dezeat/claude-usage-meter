# claude-usage-meter

[![CI](https://github.com/dezeat/claude-usage-meter/actions/workflows/ci.yml/badge.svg)](https://github.com/dezeat/claude-usage-meter/actions/workflows/ci.yml)

A [Claude Code](https://code.claude.com) plugin that surfaces your usage at a
glance — without making a single network call.

- **Live three-row statusline** — account limits with pace bars, cost-forward
  spend, and a cross-session fleet view.
- **After-task cost summary** — a per-model token and dollar breakdown printed
  when a task finishes (a `Stop` hook).
- **Off-session report** — a retrospective CLI dashboard across every project
  session.

It reads only the statusline payload Claude Code pipes in on stdin and your
local session transcripts under `~/.claude/projects`. **No network, no
telemetry, zero runtime dependencies** — just the Node built-in `node:sqlite`.

```text
limits  ctx ▓▓▓░░░░░ 40% · 5h ▓▓▓▓│▓░░░ 60% ⟳ 2h29m · 7d ▓▓▓│▓▓▓▓░ 85% ⟳ 4d15h
spend   ses $3.45 1.2M · opus $156.93 180M · Σ $235.92 227M
fleet   opus 9/23 · active ● opus 1
```

> Numbers are illustrative. Colour: **bright** = live / headline value, dim =
> idle / accumulated / chrome, the row label is accent-coloured, a green ● marks
> a live session, and bars run green → yellow → red by fill. `NO_COLOR` is
> honoured — every glyph and the layout survive, only the hue layer is dropped.

## What each row shows

| Row        | Reading                                                                                                                                                                                                                                                                     |
| :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **limits** | Account-wide context + 5-hour + 7-day usage bars with reset countdowns. Bars colour by flat fill %; the bright `│` is the even-pace tick on the 5h/7d bars (where usage _should_ be for an even burn), and it never drives colour. No model here — limits are account-wide. |
| **spend**  | Cost-forward: **`$` leads, tokens trail dim**. This **session** (live), the active **model class** this month, and **`Σ`**, the month total across every class.                                                                                                             |
| **fleet**  | The active **model class** with its sessions **this month / month total** (`9/23`), then **`active`** — other sessions live right now per class, **excluding the one you're in**. A green `●` leads each live class; the cell is dropped when nothing else is live.         |

### Glyphs

| Glyph | Meaning                                                             |
| :---- | :------------------------------------------------------------------ |
| `▓ ░` | bar fill / empty                                                    |
| `│`   | bright even-pace tick; only inside a 5h/7d bar, never drives colour |
| `·`   | faint field separator                                               |
| `/`   | "out of" — `9/23` reads as a score, never a decimal                 |
| `●`   | green live-now marker, leads each live class in `active`            |
| `Σ`   | month total across every model class                                |
| `⟳`   | resets in…                                                          |

It **degrades cleanly**: with no `rate_limits` in the payload (for example on an
API-billing account) the `limits` row is just `ctx`; with no index yet the
`spend` row is cost-only and `fleet` is dropped. A field never renders
half-empty, and the line never errors.

## Requirements

- **Node.js ≥ 22.13** — the only hard floor. The cross-session store uses the
  built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module, available
  without a flag since 22.13 (23.4 on the current line). There is **no
  `better-sqlite3`** and no native build
  step; zero runtime dependencies is a design goal.
- Claude Code (the statusline integration uses the `rate_limits` payload and the
  `refreshInterval` setting).

## Install

The statusline is the main feature, and **a Claude Code plugin cannot register
the top-level `statusLine`** — that is always a user `settings.json` setting. So
the most robust setup is to **clone to a stable path** and point your settings at
it. The committed `dist/` means a clone is runnable immediately — no build step.

### 1. Clone (runnable as-is)

```bash
git clone https://github.com/dezeat/claude-usage-meter.git \
  ~/.claude/tools/claude-usage-meter
```

### 2. Wire the statusline

Add to `~/.claude/settings.json` (or a project `.claude/settings.json`), using
the **absolute** path to your clone:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /home/you/.claude/tools/claude-usage-meter/dist/statusline.js 2>/dev/null",
    "refreshInterval": 10
  }
}
```

- `2>/dev/null` suppresses Node's `ExperimentalWarning` for `node:sqlite` so it
  never leaks into the line.
- `refreshInterval` (seconds; default `10`, minimum `1`) re-runs the command on a
  fixed idle timer _in addition_ to Claude Code's events, so the reset
  countdowns and live fleet counts keep ticking while you read or think. It runs
  locally over your own transcripts, so **refreshing costs no API tokens**, and
  an idle tick where no transcript has grown skips the index write entirely.

### 3. (Optional) Enable the after-task summary

The per-task cost summary ships as a `Stop` hook. Either load the plugin for a
session:

```bash
claude --plugin-dir ~/.claude/tools/claude-usage-meter
```

…or persist it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /home/you/.claude/tools/claude-usage-meter/dist/summary-hook.js"
          }
        ]
      }
    ]
  }
}
```

### Install via the plugin marketplace

This repo is also a single-plugin marketplace. Installing this way activates the
**after-task summary hook** automatically:

```text
/plugin marketplace add dezeat/claude-usage-meter
/plugin install claude-usage-meter@dezeat
```

The **statusline still needs the manual `settings.json` step above** (a plugin
cannot register a `statusLine`, and the marketplace cache path changes on every
update, so it is not a stable target). For the statusline, prefer the clone
install.

## Off-session report

A retrospective usage report across all project sessions:

```bash
npm run report
# or, from anywhere:
node ~/.claude/tools/claude-usage-meter/dist/report-cli.js
```

Output: per-day usage with a token sparkline, per-model-class totals, per-branch
totals, and a billing-period total.

## Where your data lives

The cross-session index is a single SQLite file at
`~/.claude/usage-meter/index.db`, built incrementally from the transcripts under
`~/.claude/projects`. Nothing leaves your machine. Delete the file to reset it;
it is rebuilt on the next run.

## Pricing

Costs come from a **hand-maintained pricing table** in
[`src/pricing.ts`](src/pricing.ts) (zero-network is the point) with a visible
`asOf` date. Unknown model ids cost `0`, are flagged, and are excluded from the
total rather than guessed — so an unpriced model never silently misstates the
figure. **Prices drift; PRs that update the table (and bump `asOf`) are
welcome** — see [CONTRIBUTING](CONTRIBUTING.md).

## Develop

```bash
npm install      # dev-only: typescript, eslint, prettier, husky
npm run check    # typecheck + lint + format check + build + tests
```

- `npm run build` compiles `src/` → `dist/` (runtime only; this is the committed,
  shipped artifact).
- `npm test` compiles to `dist-test/` (git-ignored, includes tests) and runs them
  with the Node built-in test runner.
- `claude plugin validate . --strict` validates the plugin + marketplace
  manifests.

Tests follow the source's red-green discipline; fixture expectations come from an
external oracle, never from running the implementation under test.

## License

[MIT](LICENSE) © dezeat
