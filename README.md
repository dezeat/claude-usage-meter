# claude-usage-meter

[![CI](https://github.com/dezeat/claude-usage-meter/actions/workflows/ci.yml/badge.svg)](https://github.com/dezeat/claude-usage-meter/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=node.js&logoColor=white)](package.json)

A [Claude Code](https://code.claude.com) plugin that surfaces your usage at a
glance. It reads only the statusline payload Claude Code pipes in on stdin and
your local session transcripts under `~/.claude/projects` — **no network, no
telemetry, zero runtime dependencies**, just the Node built-in `node:sqlite`.

![claude-usage-meter statusline — the current, limits, spend and fleet rows](assets/statusline.svg)

The four-row statusline above reads top to bottom: the active **model** and where
you're rooted, account **limits** with pace bars, cost-forward **spend**, and a
cross-session **fleet** view.

> Numbers are illustrative. Colour: **bright** = live / headline value, dim =
> idle / accumulated / chrome (a faint `·` separates fields), the row label is
> accent-coloured, a green `●` marks a live session, and bars run green → yellow →
> red by fill. `NO_COLOR` is honoured — every glyph and the layout survive, only
> the hue layer is dropped.

It ships three views over the same local data: the **live statusline** above
(redrawn on Claude Code's `refreshInterval`), an **after-task cost summary** — a
per-model token and dollar breakdown printed when a task finishes (a `Stop` hook)
— and an **off-session report**, a retrospective CLI dashboard across every
project session.

## What each row shows

**current** — the active model and where the session is rooted:

- **Model + version**, lowercased (`opus 4.8`). Because the model lives here, the
  rows below use a neutral `mdl` self-tag instead of repeating the class name.
- **Repo and git branch** after a `⎇`, then the **working tree** after a `⌂` —
  `root` for the main checkout, the linked-worktree name inside one — so you
  always know which of several parallel sessions this is.
- Outside a git repo it shows the directory basename with no branch. Resolved
  locally from `.git`, never a subprocess.

**limits** — account-wide, no model (it leads `current` above):

- **Context + 5-hour + 7-day** usage bars (`▓` filled, `░` empty) with reset
  countdowns after `⟳`; the **7-day** reset also spells out its absolute day
  (`⟳ 4d21h (Tu 16.06)`).
- Bars colour by flat fill %. The bright `│` is the **even-pace tick** on the
  5h/7d bars (where usage _should_ be for an even burn); it never drives colour.

**spend** — cost-forward, **`$` leads, tokens trail dim**:

- This **session** (live), then **this model** (`mdl`) this month.
- **`Σ`** — the month total across every class.
- Each cell's token trail splits as **`i:420.0k|c:11.9M|o:14.0k`** — fresh
  **i**nput (cache writes included), **c**ached reads, **o**utput. `c` is the
  ~free bucket that explains a low dollar figure; `i+c+o` is the cell's total.

**fleet** — `mdl <count> Σ <total>` then `active` (e.g. `9 Σ 23`):

- **This model** (`mdl`), its sessions **this month**, a dim `Σ`, then the
  **month total** across every class.
- **`active`** — other sessions live right now per class, named by their real
  class (the row's one exception to `mdl`) and **excluding the one you're in**. A
  green `●` leads each live class; the cell is dropped when nothing else is live.

### Subagents

A subagent runs in its own transcript file (`isSidechain`) but is not a separate
user session, so it is accounted carefully:

- Its cost **rolls into the parent session's `ses` total**.
- In the **per-class spend cells** it is priced under the **subagent's own model
  class**, never relabelled — a Haiku subagent under an Opus parent shows as Haiku
  spend, because that is what was billed.
- The **session counts** (`fleet`'s `N Σ total` and the `active ●` tally) include
  only top-level sessions, so a subagent is never tallied as one.

So the fleet count can show `0` haiku _sessions_ alongside nonzero haiku _spend_ —
a subagent produced Haiku cost without being a session. Correct, not a bug.

It **degrades cleanly.** The `current` row shows the model alone when the working
dir is unknown, the directory basename outside a git repo, and is dropped when
neither model nor location is known. With no `rate_limits` in the payload (e.g. an
API-billing account) the `limits` row is just `ctx`; with no index yet `spend` is
cost-only and `fleet` is dropped. A field never renders half-empty, and the line
never errors.

## How spend & fleet are computed

Every figure is auditable — it comes from your own transcripts and a
hand-maintained price table, with **no network call**. The
[architecture map](https://github.com/dezeat/claude-usage-meter/discussions/46)
covers the moving parts (pure-core / I-O-edge split, three data flows).

- **`ses` tokens** are aggregated by `aggregate.ts` (input / output / cache-read /
  cache-create) and deduped by `message.id + requestId` exactly as
  [ccusage](https://github.com/ryoppippi/ccusage) does, so a resumed or retried
  turn is never double-counted, then priced by the `pricing.ts` table (dateless
  aliases; a `-YYYYMMDD` snapshot prices as its alias).
- **`mdl` this month, `Σ`, and the fleet counts** come from the cross-session
  `node:sqlite` index — one row per **top-level** session carrying its priced cost
  and model class. `active ●` tallies sessions whose `lastTs` is within the
  liveness window (`LIVENESS_WINDOW_MS`, 5 min), **excluding the one you're in**.
- **Two cost sources, one rule.** The payload's running `cost.total_cost_usd` is
  authoritative for the **live, not-yet-indexed** session (the `ses` cell falls
  back to it); the index's price-table calc is authoritative for everything
  **persisted**. An unknown model costs `$0`, is flagged `⚠`, and is **excluded**
  from the total — never guessed.
- **Why the dollars look low for the token count:** agentic usage is dominated by
  **cache reads**, billed ~50× cheaper than output, so total cost sits far below
  `tokens × output-rate`. The **report CLI** and **`Stop` summary** print the
  four-way split with a cache-read share (e.g. `96% cache reads`) so it is legible.
- **Subagents are attributed, not counted** (see [Subagents](#subagents) above):
  each gets its own index row but is **never tallied as a session**, while its
  spend rolls into the parent's `ses` under its own class
  ([ADR-0001](docs/decisions/ADR-0001-subagent-row-per-file.md),
  [ADR-0002](docs/decisions/ADR-0002-subagent-spend-follows-real-model.md)).

## Requirements

- **Node.js ≥ 22.13** — the only hard floor. The cross-session store uses the
  built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) module, available
  without a flag since 22.13. There is **no `better-sqlite3`** and no native build
  step; zero runtime dependencies is a design goal.
- **Claude Code** — the statusline uses the `rate_limits` payload and the
  `refreshInterval` setting.

## Install

Two parts: the **`Stop` hooks** (after-task summary + cross-session self-persist)
and the **statusline**. A Claude Code plugin can register the hooks but **not the
top-level `statusLine`** — that is always a user `settings.json` setting — so the
statusline is wired manually in both paths below.

### Recommended: plugin marketplace + manual statusline

This repo is a single-plugin marketplace. Installing it activates both `Stop`
hooks automatically:

```text
/plugin marketplace add dezeat/claude-usage-meter
/plugin install claude-usage-meter@dezeat
```

Then wire the statusline. The marketplace cache path changes on every update, so
**clone to a stable path** for the statusline and point `settings.json` at it
(the committed `dist/` is runnable immediately — no build step):

```bash
git clone https://github.com/dezeat/claude-usage-meter.git \
  ~/.claude/tools/claude-usage-meter
```

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
  fixed idle timer _in addition_ to Claude Code's events, so reset countdowns and
  live fleet counts keep ticking while you read. It runs locally over your own
  transcripts, so **refreshing costs no API tokens**. A quiet tick — nothing new
  under `~/.claude/projects` — skips the cross-project sweep and the index write
  entirely behind a directory-mtime watermark; the active session is still
  re-read every tick, so its numbers never go stale.

### Manual hooks (clone-only, no marketplace)

If you skip the marketplace, register the two `Stop` hooks yourself.
**`summary-hook.js`** prints the per-model cost summary when a task finishes;
**`index-hook.js`** self-persists _this_ session on every turn-end (a targeted,
event-driven write — see
[ADR-0003](docs/decisions/ADR-0003-event-write-targeted-stop-hook.md)) so other
live sessions' `fleet` rows see it on their next refresh. Each hook is
failure-isolated and never blocks the turn.

Load the plugin per session:

```bash
claude --plugin-dir ~/.claude/tools/claude-usage-meter
```

…or persist them in `~/.claude/settings.json`:

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
      },
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /home/you/.claude/tools/claude-usage-meter/dist/index-hook.js"
          }
        ]
      }
    ]
  }
}
```

## Off-session report

A retrospective dashboard across all project sessions — per-day usage with a token
sparkline, per-model-class and per-branch totals, and a billing-period total:

```bash
npm run report
# or, from anywhere:
node ~/.claude/tools/claude-usage-meter/dist/report-cli.js
```

## Where your data lives

The cross-session index is a single SQLite file at
`~/.claude/usage-meter/index.db`, built incrementally from the transcripts under
`~/.claude/projects`. It is written two local, idempotent ways: the statusline
sweeps every project on each refresh, and the `Stop` `index-hook` self-persists
the current session (with its subagents) on every turn-end. Each transcript is one
row keyed by byte offset, so a line counts exactly once whichever path writes it.
Nothing leaves your machine. Delete the file to reset it; it rebuilds on the next
run.

## Pricing

Costs come from a **hand-maintained pricing table** in
[`src/pricing.ts`](src/pricing.ts) (zero-network is the point) with a visible
`asOf` date; unknown ids are flagged and excluded rather than guessed. **Prices
drift; PRs that update the table (and bump `asOf`) are welcome** — see
[CONTRIBUTING](CONTRIBUTING.md).

## Develop

```bash
npm install      # dev-only: typescript, eslint, prettier, husky
npm run check    # typecheck + lint + format check + build + tests
```

- `npm run build` compiles `src/` → `dist/` (the committed, shipped artifact);
  `npm test` compiles to `dist-test/` (git-ignored) and runs the Node test runner.
  Tests follow a red-green discipline; expectations come from an external oracle,
  never from the implementation.
- `claude plugin validate . --strict` validates the plugin + marketplace manifests.
- **Architecture** — the pure-core / I-O-edge split and data flows are mapped in
  [docs/architecture.md](docs/architecture.md).

## License

[MIT](LICENSE) © dezeat
