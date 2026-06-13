---
name: pr
description: Open a pull request following claude-usage-meter conventions — rebase onto main, green check, branch naming, Conventional Commit title, the repo PR template, no AI attribution. Use when opening or preparing a PR.
---

# Opening a pull request

Trunk-based: every change is a short-lived branch off `main` that PRs straight to
`main`. There are no integration branches — this is a single small plugin.

## Before opening

1. **Rebase onto fresh `main`** — `git fetch origin && git rebase origin/main`;
   resolve conflicts locally. Never merge `main` into the branch.
2. **`npm run check` is green** (typecheck + lint + format-check + build + tests).
   The pre-push hook runs it, but run it yourself first.
3. **Rebuild `dist/`** if you touched `src/` (`npm run build`) and stage it — it
   is the committed runtime artifact.
4. **Pricing change?** bump `asOf` in `src/pricing.ts`.

## Branch & commit

- Branch: `<type>/<short-slug>` (e.g. `fix/concurrent-open`,
  `feat/event-writes`).
- Conventional Commit title: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`,
  `chore:`. One logical change per commit.
- **No AI attribution** in commits or PR text — no `Co-Authored-By`, no
  "Generated with", no agent-tool mentions.

## The PR

- Title = the Conventional Commit summary.
- Body follows `.github/PULL_REQUEST_TEMPLATE.md`: **What & why**, the
  **Checklist** (tick what applies), and **Notes** (trade-offs, follow-ups).
- For a behaviour change, the checklist's external-oracle test box must hold: the
  expectation comes from ccusage / published pricing / the maintainer, not from
  running the implementation under test.
- Open with `gh pr create --base main`. The `check` matrix and `Security`
  workflow must be green before merge. Merging to `main` is the maintainer's
  call.
