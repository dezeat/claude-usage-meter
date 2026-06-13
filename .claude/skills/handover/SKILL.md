---
name: handover
description: Hand off the session to the next one by posting a structured handover to GitHub (a tracking-issue comment or a Discussion), not a local file — durable and visible across sessions, users, and machines. Use at session end, when context grows long, or before switching workstreams.
argument-hint: "What will the next session focus on?"
---

Post a handover so a fresh session — on any machine, run by anyone — can continue.

## Where it goes (GitHub, not a local file)

Handovers are coordination state, so they live in GitHub where every session,
user, and machine can see them — not in a gitignored local file that dies with
the clone. (Context lost between agents is the dominant multi-agent failure mode.)

Pick the closest home, in order:

1. **A comment on the tracking issue** for the unit of work
   (`gh issue comment <n> --body-file -`). The default — the handover sits in the
   issue timeline next to its acceptance criteria and linked PRs.
2. **A Discussion** in the `Handovers` (or `Coordination`) category when the work
   spans several issues or has no single tracking issue.
3. **A new issue** labelled `handover`, only if neither fits — then link it from
   the relevant work.

Do **not** write `docs/handovers/*.md` in this repo — that pattern is retired.

## Structure

1. **Goal** — the unit of work; link the epic/story/ticket issue (`#NN`).
2. **State** — done & verified vs in progress vs untouched; link merged PRs by
   number and the commit / CI run that proves "verified".
3. **Next steps** — concrete, ordered; the first startable immediately. Link the
   issues they map to.
4. **Gotchas** — non-obvious things learned the hard way this session.
5. **Suggested skills** — e.g. `grill-me-with-docs` before design, `parallel` for
   independent workstreams.

## Rules

- **Reference, don't duplicate.** Link issues / PRs / commits / Discussions by
  number or URL instead of restating them. The repo's binding agentic docs
  (`CLAUDE.md`, ADRs under `docs/decisions/`) are the source of truth — point at
  them.
- **Redact secrets and personal data** — this repo is public; a handover comment
  is world-readable the moment it posts.
- **Update the tracker too:** move the issue / Project card to reflect reality
  (in progress / blocked / done) so the board stays the single source of status.
- If arguments describe the next focus, tailor the Next steps to it.
- A quick local scratch note in-flight is fine, but the **canonical** handover is
  the GitHub artifact.
