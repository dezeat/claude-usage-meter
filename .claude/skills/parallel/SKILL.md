---
name: parallel
description: Set up, list, or tear down git worktrees for parallel agent sessions, each bound to a GitHub issue so the work stays coordinated and observable. Use when running independent workstreams at once or when the user asks for a worktree.
argument-hint: "<issue # or workstream> | list | done <branch>"
---

Manage parallel workstreams via git worktrees, coordinated through GitHub issues.

## Conventions

- Worktrees live in `.worktrees/<branch-slug>/` (gitignored).
- Branch naming: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`.
- **One session per worktree, one worktree per GitHub issue.** The issue is the
  shared grounding that keeps parallel agents from drifting or colliding — assign
  it and move its Project card to "in progress" when you start.

## Creating a workstream

1. Ensure `main` is clean and current; branch worktrees off `origin/main`.
2. `git worktree add .worktrees/<slug> -b <branch> origin/main`
3. `npm ci` inside the worktree — a worktree has its **own** `node_modules` (the
   committed `dist/` is shared via git, but dependencies are not).
4. Bind it to its issue: note the branch/worktree in an issue comment and move the
   board card. If the next session needs context, post a `handover` to that issue
   first.
5. Start the session with `claude` from `.worktrees/<slug>/`.

## Rules for parallelizing

- Only parallelize **independent** work — two sessions must never edit the same
  module. The pure-core / I/O-edge seams in `src/` are the natural boundaries; a
  shared file (e.g. `pricing.ts`, the line assembler in `render.ts`) means
  serialize, not fan out.
- Public-surface changes land on `main` first via PR; dependent workstreams rebase
  on the new `main`, they don't guess.
- Keep workstreams short-lived — long-running worktrees drift and rebase painfully.
- Every workstream ships a small focused **PR** into `main` and is reviewed
  (`pr` skill) before merge. No direct pushes to `main`.

## Listing

`git worktree list` — report each worktree with its branch, its bound issue, and
whether it has uncommitted changes or unpushed commits.

## Finishing a workstream (`done <branch>`)

1. In the worktree: commit everything; `npm run check` green; rebuild and stage
   `dist/` if `src/` changed.
2. Open/finish the **PR** to `main` (rebased on `origin/main`), let CI go green,
   merge it (the `pr` skill carries the mechanics), and close its issue.
3. `git worktree remove .worktrees/<slug>` and `git branch -d <branch>`, then
   `git worktree prune`.
4. Never remove a worktree with uncommitted changes without asking first.
