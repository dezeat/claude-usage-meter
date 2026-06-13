---
name: grill-me-with-docs
description: Relentless one-question-at-a-time interview about a plan or design, challenged against the GitHub-hosted context (issues, the Project, design Discussions) and the in-repo binding docs (CLAUDE.md, ADRs), crystallizing the outcome back into GitHub. Use before design work, a new epic/story, or when the user says "grill me".
---

<what-to-do>

Interview me relentlessly about every aspect of this plan until we reach a shared
understanding. Walk each branch of the design tree, resolving dependencies between
decisions one at a time. For each question, give your recommended answer.

Ask **one question at a time**, waiting for my answer before the next.

If a question can be answered from the code, the issues, the Discussions, or the
in-repo docs, **explore instead of asking**.

</what-to-do>

<supporting-info>

## The context set (read before the first question)

Most context lives in **GitHub**, not the repo — reach it via `gh`:

- **Scope & work** — open issues and the Project board (`gh issue list`,
  `gh project item-list`). Epics / stories / tickets and their acceptance criteria
  live here.
- **Prior design & knowledge** — Discussions (`gh api repos/{owner}/{repo}/discussions`),
  especially the `Design` / `Decisions` categories: past debates, open questions,
  rationale.
- **Binding in-repo agentic docs** — `CLAUDE.md` (operating rules, architecture
  invariants, the zero-runtime-deps law) and ADRs under `docs/decisions/` (the
  decisions an implementer must respect in-context). These few docs stay in the
  repo _because_ an agent needs them in its context window while coding.

## During the session

- **Challenge against the invariants.** When a term or plan conflicts with
  `CLAUDE.md` or an ADR, call it out: "ADR-0003 says the core is pure and
  zero-runtime-deps, but this adds an I/O call to a pure module — which gives?"
- **Challenge against scope.** When the plan drifts past an issue's stated scope
  or a non-goal, say so before going deeper. Guardrails beat excitement.
- **Sharpen fuzzy language** into precise, canonical terms.
- **Stress-test with concrete scenarios** that force precision about boundaries
  ("two sessions on two machines upsert the index in the same second — what does
  each statusline show?").
- **Cross-reference with code** and surface contradictions.

## Crystallizing the outcome (back into GitHub)

When a question resolves, record it where the right audience will find it:

- **Scope / task change →** edit the **issue** (description or a comment) and move
  its Project card. The issue is the live source of "what & status".
- **A real decision** (hard to reverse, surprising without context, a genuine
  trade-off) **→** a short **ADR** at `docs/decisions/ADR-NNNN-<slug>.md` (the
  binding, in-context artifact) **plus** a summary in a `Decisions` **Discussion**
  for the rationale and debate trail. A changed mind adds a new ADR marked
  `superseded by`; it never edits an old one.
- **Open design narrative / knowledge →** a **Discussion** in `Design`, not a repo
  doc — searchable, and other people/sessions can weigh in.

Keep ADRs short and binding; keep the long-form _why_ in the Discussion.

</supporting-info>
