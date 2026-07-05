# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
From the next release onward, entries below are generated from
[Conventional Commits](https://www.conventionalcommits.org/) by release-please.

## [1.0.1](https://github.com/dezeat/claude-usage-meter/compare/v1.0.0...v1.0.1) (2026-07-05)


### CI

* bump codeql-action to v4 and group the coupled init/analyze pair ([9d981bb](https://github.com/dezeat/claude-usage-meter/commit/9d981bb77ed890f38c3b6578bec9d6b9338505e6))

## 1.0.0 (2026-07-02)

### Features

- add single-plugin marketplace manifest ([851d3b8](https://github.com/dezeat/claude-usage-meter/commit/851d3b81df1cfdd5eb3ad30ad89789bd5c32b907))
- always-on working-tree cell, plus 2-letter weekday and shorter bars ([#57](https://github.com/dezeat/claude-usage-meter/issues/57)) ([bc226ae](https://github.com/dezeat/claude-usage-meter/commit/bc226aedb5d99780f708c0a1d2cd05233f5ef816))
- credit subagent tokens to the parent session (N8) ([#30](https://github.com/dezeat/claude-usage-meter/issues/30)) ([d199cc3](https://github.com/dezeat/claude-usage-meter/commit/d199cc3082f502707d2f08226fcb8b2674435691))
- cross-session limits sync + H3 read indexes (schema v3) ([79ac3ae](https://github.com/dezeat/claude-usage-meter/commit/79ac3ae0a0f7e30cc0c76146e98dfea5f16fd9f5))
- debounce the hot-path sweep behind a per-claudeDir mtime watermark ([84e6e62](https://github.com/dezeat/claude-usage-meter/commit/84e6e62c8049241425860dee5f407d5a2acba8c1))
- event-based DB writes — sessions self-persist on Stop (N6) ([#29](https://github.com/dezeat/claude-usage-meter/issues/29)) ([b5cae81](https://github.com/dezeat/claude-usage-meter/commit/b5cae81ff5378c52b3c3a9911059780dc0efeb67))
- fleet count cell joins month count and total with a Σ connective ([#11](https://github.com/dezeat/claude-usage-meter/issues/11)) ([806e189](https://github.com/dezeat/claude-usage-meter/commit/806e189e55d8902eff2e60a1b80e83efce32ffdf))
- now row shows the active git worktree ([3bc35cf](https://github.com/dezeat/claude-usage-meter/commit/3bc35cf3777a1130287d46a88b749d730ef80b6f))
- rename the `now` statusline row label to `current` ([b88286c](https://github.com/dezeat/claude-usage-meter/commit/b88286c8ba0fde4f30a83a5ce071c2269419abc7))
- spell out the 7d limit's absolute reset day ([4c5e261](https://github.com/dezeat/claude-usage-meter/commit/4c5e26125fbb0b2162ae56c1844367f6803a609c))
- spend row splits the token trail as i|c|o (ADR-0005) ([a521a4f](https://github.com/dezeat/claude-usage-meter/commit/a521a4fa9b11862cf5ae681b2a6dab08a3220e40))
- surface input/output/cache token breakdown in report and summary ([748b904](https://github.com/dezeat/claude-usage-meter/commit/748b904e130756764554224318d429519717e74f))
- top "now" row (model + repo/branch) and mdl self-tag ([#33](https://github.com/dezeat/claude-usage-meter/issues/33)) ([da5c9c4](https://github.com/dezeat/claude-usage-meter/commit/da5c9c4cb66a8ecb99f41f4395aa9d9ec461b24b)), closes [#19](https://github.com/dezeat/claude-usage-meter/issues/19)
- **usage-meter:** fleet roster + monthly spend on statusline (E01-S04-T02) ([#26](https://github.com/dezeat/claude-usage-meter/issues/26)) ([454dfd3](https://github.com/dezeat/claude-usage-meter/commit/454dfd318ec1acb5449f0743a808f93209f46918))
- **usage-meter:** incremental cross-session index (E01-S04-T01) ([#23](https://github.com/dezeat/claude-usage-meter/issues/23)) ([c199095](https://github.com/dezeat/claude-usage-meter/commit/c19909550b9663c80e624ab0c5697673cf1590ed))
- **usage-meter:** off-session report dashboard CLI (E01-S04-T03) ([#27](https://github.com/dezeat/claude-usage-meter/issues/27)) ([4d7f654](https://github.com/dezeat/claude-usage-meter/commit/4d7f654fa3b4b385c60a74e7d6277223aff92abb))
- **usage-meter:** self-built usage-meter plugin — statusline + after-task cost summary (E01 S01+S02) ([#9](https://github.com/dezeat/claude-usage-meter/issues/9)) ([a08b669](https://github.com/dezeat/claude-usage-meter/commit/a08b669bce9e8423eac67688fed96c444d9d59a5))
- **usage-meter:** statusline legibility — model pin, mdl ref, cost-forward spend, self-excluded live count + 10s refresh ([#43](https://github.com/dezeat/claude-usage-meter/issues/43)) ([bb8fad9](https://github.com/dezeat/claude-usage-meter/commit/bb8fad9387a3545066260278145dbf67bd4f7ed8))
- **usage-meter:** statusline redesign + SQLite cross-session store (E01-S05) ([#42](https://github.com/dezeat/claude-usage-meter/issues/42)) ([2ed0bb3](https://github.com/dezeat/claude-usage-meter/commit/2ed0bb3c1e79974f6f4f413b49c47c9b822b0651))
- v0.1.0 polish — cost breakdown, worktree row, CI hardening, spend/fleet docs ([6aa20ee](https://github.com/dezeat/claude-usage-meter/commit/6aa20eecb464c42303a6b733f888c9fc1b42e06e))

### Bug Fixes

- bump the marketplace manifest version in the release PR ([162642d](https://github.com/dezeat/claude-usage-meter/commit/162642d7bc4d06317ed12a85ba2b01a090fac1e0))
- countdown shows only its largest time unit ([9e82077](https://github.com/dezeat/claude-usage-meter/commit/9e82077fda6cba0e3a021d6bb230062b3155e012))
- discover transcripts across all projects, not just midnight-marble ([#10](https://github.com/dezeat/claude-usage-meter/issues/10)) ([ccb9c3a](https://github.com/dezeat/claude-usage-meter/commit/ccb9c3ab4f826e7d8aaf4cd328402d2af89148d5))
- price legacy/dated model ids — $15/$75 Opus 4.0/4.1, Mythos 5, date-suffix normalization ([#3](https://github.com/dezeat/claude-usage-meter/issues/3)) ([9334892](https://github.com/dezeat/claude-usage-meter/commit/93348923be1217f631efaca5972b86eb24c5e5c2))
- raise Node floor to 22.13 for unflagged node:sqlite ([#1](https://github.com/dezeat/claude-usage-meter/issues/1)) ([70ba381](https://github.com/dezeat/claude-usage-meter/commit/70ba381e96f47afe7511e2260c21aa4df0e48dd6))
- retry WAL switch to end concurrent-open "database is locked" flake ([#2](https://github.com/dezeat/claude-usage-meter/issues/2)) ([3305398](https://github.com/dezeat/claude-usage-meter/commit/33053988bf8bb577d062f1b999acd8447c4c1f13))
- **usage-meter:** add space after ⟳ glyph to prevent terminal overlap ([#13](https://github.com/dezeat/claude-usage-meter/issues/13)) ([6e8f256](https://github.com/dezeat/claude-usage-meter/commit/6e8f256116b4d7ac4381f343e6b818549127351d))
- **usage-meter:** space the ⟳ countdown + move model name to fleet/spend off limits ([#44](https://github.com/dezeat/claude-usage-meter/issues/44)) ([1e7bd6d](https://github.com/dezeat/claude-usage-meter/commit/1e7bd6dd4bd69fc8600dcbae222698487c87b450))

### Refactoring

- unify the ses cell (R4), centralize formatUsd (R5), ADR-0004 two cost sources (R3) ([07814c2](https://github.com/dezeat/claude-usage-meter/commit/07814c278e7bb14491f3fd2c04fb20399355251f))

### Documentation

- add ADR-0004 naming the two cost sources ([8052037](https://github.com/dezeat/claude-usage-meter/commit/805203797e4e9236f9088e12902794e2c6756808))
- add CLAUDE.md and a repo-specific pr skill ([#8](https://github.com/dezeat/claude-usage-meter/issues/8)) ([1af62f8](https://github.com/dezeat/claude-usage-meter/commit/1af62f834553a1616d00c9a491130aab7b716855))
- add CODE_OF_CONDUCT (Contributor Covenant 2.1) ([3e689c5](https://github.com/dezeat/claude-usage-meter/commit/3e689c52ae433827952a3efa260654a5c39e5946))
- ADR-0005 spend-row token vocabulary (i|c|o, cache writes count as input) ([1f00d97](https://github.com/dezeat/claude-usage-meter/commit/1f00d97fd7cc8c0b4066bea17849a2f625ee8308))
- ADRs for the N6/N8 design pass ([#27](https://github.com/dezeat/claude-usage-meter/issues/27)) ([4b6cbb7](https://github.com/dezeat/claude-usage-meter/commit/4b6cbb7e77b95ea667a7edb02a79075ecf401d1a))
- explain how the spend and fleet numbers are computed ([e49d2ea](https://github.com/dezeat/claude-usage-meter/commit/e49d2ea3cffaef647c8f19c40805774ba4b2a431))
- GitHub-native PM/docs model + port parallel/grill/handover skills ([#9](https://github.com/dezeat/claude-usage-meter/issues/9)) ([18cfbcd](https://github.com/dezeat/claude-usage-meter/commit/18cfbcdd705d037da72ce567da70bce356b110e4))
- in-repo C4 architecture diagram (hand-drawn) + diagramming skill ([026044a](https://github.com/dezeat/claude-usage-meter/commit/026044abc3883f9a83438c20f5e2ddf9defe7d10))
- polish README for v0.1.0 (bulleted rows, leaner Install, architecture link) ([f4b3eb8](https://github.com/dezeat/claude-usage-meter/commit/f4b3eb83b1ab13f0f75f2712a961878a92a2ec4a))
- pre-release polish — hero SVG at current rendering, four-row wording, largest-unit countdown example ([8c894d4](https://github.com/dezeat/claude-usage-meter/commit/8c894d4674ee279a2a36ac9e23b52d9642088529))
- README quiet tick reflects the mtime-watermark sweep skip ([a3cc095](https://github.com/dezeat/claude-usage-meter/commit/a3cc09594c9e78bd45f43f1f3289e5718575778a))
- refresh hero statusline.svg to current rendering ([69eed58](https://github.com/dezeat/claude-usage-meter/commit/69eed58d3728f8a924bb48e8478858185e60c01a))
- refresh README for event-driven writes and subagent accounting ([#31](https://github.com/dezeat/claude-usage-meter/issues/31)) ([f088696](https://github.com/dezeat/claude-usage-meter/commit/f08869604e1af6cac96328fb1b663436fb339222))
- rewrite README for the public and add OSS project docs ([b9a21e8](https://github.com/dezeat/claude-usage-meter/commit/b9a21e86344f64c31d709ca53f199c9f41f5d44e))

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
