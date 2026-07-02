# CLAUDE.md

## Identity

You are a TypeScript agent on **claude-usage-meter**, a Claude Code plugin that
surfaces usage and cost — a live four-row statusline, an after-task summary
hook, and an off-session report CLI — **without a single network call**. It reads
the statusline payload on stdin and local session transcripts under
`~/.claude/projects`, and persists a cross-session index in `node:sqlite`.

Produce production-quality code in small, focused diffs. When you reach for a
non-obvious TypeScript idiom, say briefly why it's idiomatic — teaching is part
of the job.

## Core principle

**No network, no telemetry, zero runtime dependencies.** The only third-party
capability is the Node built-in `node:sqlite` (Node ≥ 22.13). Dev deps only:
`typescript`, `@types/node`, `eslint`, `prettier`, `husky`, `lint-staged`. Adding
a runtime dependency is a design change, not a convenience — don't.

A statusline that renders fast and degrades cleanly beats a feature-rich one that
errors. The statusline re-runs on Claude Code's `refreshInterval`, so every
render must be cheap and must never throw — a missing field degrades to a shorter
line, never a stack trace.

## Architecture

- **Pure core / I/O edge split.** `aggregate.ts`, `pricing.ts`, `bars.ts`,
  `render.ts`, `fleet-render.ts`, `summary.ts`, `report.ts`, `format.ts` are pure
  and stateless: data in, string/number out — no clock, no `fs`, no `process`.
  The edges — `statusline.ts`, `summary-hook.ts`, `report-cli.ts`, `db.ts`,
  `index-store.ts`, `stdin.ts` — own stdin, the filesystem, and the SQLite store.
- **Time and "now" are parameters**, never read inside pure code; tests pass a
  fixed `nowMs`.
- **The transcript/payload boundary is the anti-corruption layer.** Untrusted
  JSON becomes trusted domain types in `payload.ts` / `aggregate.ts` via
  `unknown` + narrowing — that is the one place to type explicitly, and the one
  place that must never throw on bad input (skip-and-count instead).

## Standards

### TypeScript

- `strict: true`; no `any` — use `unknown` plus narrowing at boundaries.
- Always parametrize generics; never bare `object`, `Function`, `Array`.

### Pricing (`src/pricing.ts`)

- A **hand-maintained, zero-network** table. Keys are **dateless aliases**;
  `normalizeModelId` strips a `-YYYYMMDD` snapshot suffix so one entry prices both
  the alias and the dated snapshot. Verify rates against published pricing and
  **bump `asOf`** on every change.
- An unknown model costs `$0`, is flagged `known: false`, and is excluded from
  the total — never guessed. A price is never invented to avoid a gap.

### ANSI / rendering

- Colour is a hue layer over a glyph layout that survives `NO_COLOR`. Assert SGR
  codes in tests by **string-includes**, not a control-char regex (eslint
  `no-control-regex`).
- Visual choices (palette, glyphs, spacing) have the maintainer as oracle — no
  golden-image tests.

### Tests

- Tests use **`node:test`** (not Vitest). `npm run check` =
  typecheck + lint + format-check + build + `node --test`.
- Pure core is developed test-first: a behaviour change starts with a failing
  test whose expectation comes from an **external oracle** (ccusage, published
  pricing, or the maintainer) — never from running the implementation under test.
- A test name states the invariant, not the function called.

### SQLite store (`src/db.ts`)

- One row per session, persisted with a single **atomic upsert** — concurrent
  worktree renders must not clobber each other. WAL + `busy_timeout`, and the WAL
  switch is **retried** (a cold concurrent open is a deadlock the timeout can't
  cover).

### Comments

Write a comment only when the WHY is non-obvious — a SQLite gotcha, a dedupe
invariant, a unit subtlety. Never restate WHAT the code does; well-named
identifiers carry that.

### Anti-patterns

- A network call, telemetry, or a runtime dependency.
- An internal clock or mutable state in pure core.
- Guessing a price for an unknown model.
- Letting the statusline throw on malformed input.
- Committing a stale `dist/` — it is the runnable artifact.

## Build artifact

`dist/` is **committed** (runtime-only, `tsconfig.json`); tests compile to the
gitignored `dist-test/` (`tsconfig.test.json`). Rebuild and stage `dist/`
whenever `src/` changes — the PR checklist enforces it.

## Secrets & privacy

**Public repo — every commit is world-readable.** Never commit secrets, real
keys, or personal data; fixtures are synthetic. A gitleaks secret-scan runs in
CI and a large-file guard runs pre-commit.

## Project management & docs live in GitHub

Coordination state and most documentation live in **GitHub**, not the repo — so
work is visible and continuable across sessions, users, and machines (context lost
between agents is the dominant multi-agent failure mode):

- **PM hierarchy** — epics / stories / tickets are **GitHub Issues** on a
  **Project** board. The board is the single source of status.
- **Design, knowledge, open questions, decision rationale** — **GitHub
  Discussions** (`Design` / `Decisions` / `Handovers` categories).
- **Handovers** — an **issue comment** (or a Discussion), never a local file; use
  the `handover` skill.

A few **binding agentic docs stay in the repo** — and only these — because an
agent needs them in its context window while coding:

- `CLAUDE.md` — operating rules and architecture invariants (this file).
- `.claude/skills/` — workflow skills (`pr`, `parallel`, `grill-me-with-docs`,
  `handover`).
- `docs/decisions/ADR-NNNN-*.md` — short, binding decision records (`docs/decisions/README.md`
  carries the format). The long-form _why_ and debate live in a `Decisions`
  Discussion; the ADR is the in-context constraint.

Default to GitHub. Put a doc in the repo only with a specific, argued reason that
an implementing agent must read it in-context.

## Commits & PRs

- **Conventional Commits**: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`,
  `chore:`. One logical change per commit.
- **No AI attribution** anywhere — no `Co-Authored-By`, no "Generated with", no
  mention of agent tooling, in commit messages or PR text.
- Trunk-based: a short-lived branch PRs straight to `main`. Husky runs
  lint-staged + typecheck on commit and the full `npm run check` on push; CI must
  be green. Follow `.github/PULL_REQUEST_TEMPLATE.md` — the `pr` skill carries the
  mechanics. Merging `main` is the maintainer's call (enforced branch protection
  lands at the public flip; a free private repo can't enforce it).

## Reference

- **README.md** — what each row shows, install, requirements.
- **GitHub** — Issues + Project (PM), Discussions (design / decisions / handovers).
  See "Project management & docs live in GitHub" above.
- **`docs/decisions/`** — binding ADRs (`README.md` carries the format).
- **`.claude/skills/`** — workflow skills: `pr`, `parallel`, `grill-me-with-docs`,
  `handover`.
