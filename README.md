# usage-meter

A self-built Claude Code plugin that surfaces your usage at a glance:

- **Live statusline** — model, context fill, and 5-hour / 7-day limit
  **pace bars** with reset countdowns. The pace marker (`│`) shows where
  your usage _should_ be for an even burn across the window; filled cells
  past it (overshoot) turn red, so you see a limit coming.
- **After-task summary** — a per-model token and cost breakdown after each
  task _(coming in story S02)_.

No network calls, no telemetry, no runtime dependencies — it reads only
the statusline payload Claude Code pipes on stdin and your local session
transcripts. Pricing is a hand-maintained table in source.

## Develop

```bash
cd plugins/usage-meter
npm install     # dev-only: typescript + @types/node
npm run check   # typecheck + build + tests
```

The build compiles `src/` to `dist/` (git-ignored). `npm test` rebuilds
first, so the compiled `dist/statusline.js` always matches source.

## Use it

The statusline script is activated by a `statusLine` entry in your user or
project settings — **not** by loading the plugin. (A plugin manifest
cannot register the main statusLine; its own `settings.json` supports only
`agent` / `subagentStatusLine`.) Build first, then add to
`~/.claude/settings.json` (or a project `.claude/settings.json`):

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/plugins/usage-meter/dist/statusline.js",
    "refreshInterval": 3
  }
}
```

Use the absolute path to wherever this directory lives. On an
API-billing account (no `rate_limits` in the payload) the line degrades
to model + context + cost and never errors.

`refreshInterval` (seconds, default `3`, minimum `1`) re-runs the command
on a fixed idle timer _in addition_ to Claude Code's events. Without it the
line goes quiet between messages, so the reset countdowns and the live
fleet counts freeze while you read or think; the timer keeps them ticking.
The script runs locally over your own transcripts — refreshing costs **no
API tokens** — and an idle tick where no transcript has grown skips the
index write entirely, so each tick stays cheap. Tune it up if you prefer a
calmer bar; `1` is the lowest the harness accepts.

The after-task summary (S02) ships as a `Stop` hook and _is_ activated by
loading the plugin:

```bash
claude --plugin-dir /absolute/path/to/plugins/usage-meter
```

## Off-session report

Run a retrospective usage report across all project sessions:

```bash
cd plugins/usage-meter
npm run report
```

Output: per-day usage with a token sparkline, per-model-class totals, per-branch totals, and a billing-period total.

## Status

- [x] S01-T01 — plugin scaffold
- [x] S01-T02 — statusline renderer (pace bars)
- [x] S02-T01 — transcript aggregation
- [x] S02-T02 — pricing table, cost, after-task summary box (Stop hook)
- [ ] S03 — distribution + pricing-staleness policy (deferred)
- [x] S04-T01 — incremental cross-session index
- [x] S04-T02 — statusline fleet roster + monthly $
- [x] S04-T03 — off-session report dashboard CLI
