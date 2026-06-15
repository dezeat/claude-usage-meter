---
name: architecture-diagram
description: Author or update the repo's architecture diagram as a C4 view rendered hand-drawn (mermaid look handDrawn), derived from the actual src/ import graph, with a native GitHub fenced block plus a committed SVG. Use when the architecture changes, a module moves across the pure/edge line, or the diagram drifts from the code.
---

Keep `docs/architecture.md` and `assets/architecture.svg` an honest picture of the
system. The diagram is an **authoring artifact** (like the hero `assets/statusline.svg`)
— the mermaid source is the source of truth; the SVG is its render.

## Model: C4, only as deep as it earns

Use the [C4 model](https://c4model.com/), but stop at the level that adds signal:

- **Level 1 · Context** — who/what is _outside_ the plugin: Claude Code (the host
  CLI), the operator, and the on-disk state (transcripts + the `node:sqlite` index).
  Always present.
- **Level 2 · Container** — the process surfaces _inside_ the plugin: the I/O-edge
  entry points and the pure core. Always present.
- **Level 3 · Component** — individual modules and the edges between them. Include
  **only where it earns it** — here it earns it, because the whole point is to show
  the pure-core / I-O-edge split and the `payload.ts` / `aggregate.ts`
  anti-corruption boundary. Don't draw a Code (Level 4) view; the source is the source.

## Derive the graph from imports, never memory

The arrows must match reality. Read the real dependency edges before drawing:

```sh
# local imports per non-test module
for f in src/*.ts; do
  case "$f" in *.test.ts) continue;; esac
  printf '### %s\n' "$f"
  grep -nE 'from "\./' "$f"
done
```

A `type`-only import across the pure/edge line is allowed (e.g. `location.ts` imports
the `Location` _interface_ from `render.ts`) — note it as type-only rather than hiding
it. If an edge contradicts an invariant in `CLAUDE.md`, that is a finding, not a line
to omit.

## Convention: mermaid `look: handDrawn`

Render hand-drawn (Excalidraw-style) via mermaid's `look: handDrawn`, which uses
[rough.js](https://github.com/rough-stuff/rough) — the same sketch engine Excalidraw
uses. This keeps **zero runtime dependencies**: the renderer runs from `npx --yes`,
never `package.json`. Put the config in the front-matter of the `.mmd` so the native
GitHub fenced block renders the same way the SVG does:

```
---
config:
  look: handDrawn
  theme: neutral
---
flowchart TB
  ...
```

## The pure/edge colour palette (reuse exactly)

Carry the invariant in hue. These `classDef`s are the canonical palette — reuse them
so the diagram, `CLAUDE.md`'s prose, and Discussion #46 stay one language:

```
classDef edge  fill:#0d3b66,stroke:#7aa7d8,color:#fff;             %% blue  = I/O edge
classDef core  fill:#1b4332,stroke:#74c69d,color:#fff;             %% green = pure core
classDef acl   fill:#5a3e1b,stroke:#e0a458,color:#fff,stroke-width:2px;  %% amber = anti-corruption layer
classDef store fill:#3a3a3a,stroke:#aaa,color:#fff;                %% grey  = on-disk state (cylinders)
```

- **Blue** — owns stdin, the filesystem, and the SQLite store (`statusline.ts`,
  `summary-hook.ts`, `index-hook.ts`, `report-cli.ts`, `index-store.ts`, `db.ts`,
  `location.ts`, `stdin.ts`).
- **Green** — data in, string/number out; no clock, no `fs`, no `process` (`render.ts`,
  `fleet-render.ts`, `report.ts`, `summary.ts`, `pricing.ts`, `bars.ts`, `format.ts`,
  `ansi.ts`).
- **Amber ⟂** — `payload.ts` and `aggregate.ts`, the only modules that narrow
  untrusted JSON into trusted types and must never throw.
- **Grey cylinders** — the transcripts and the `node:sqlite` index under `~/.claude`.

## Regenerate the SVG

Edit `docs/architecture.mmd` (and keep the fenced block in `docs/architecture.md` in
sync — it is the GitHub fallback), then render with the ephemeral CLI:

```sh
printf '%s\n' '{ "look": "handDrawn", "theme": "neutral" }' > /tmp/mmdc-config.json
npx --yes @mermaid-js/mermaid-cli -i docs/architecture.mmd \
  -o assets/architecture.svg -c /tmp/mmdc-config.json -b transparent
```

- `npx --yes …` is **ephemeral** — do **not** add `@mermaid-js/mermaid-cli` to
  `package.json`; the zero-runtime-deps law also bars dev-only diagram tooling that
  every contributor would have to install.
- mmdc needs a headless Chromium; in a sandbox without one it fails. **Best-effort:**
  if it can't run, commit the `.mmd` source + the native fenced block, leave the SVG
  for a follow-up render, and say so in the PR — never block the doc on the binary.

## Keep it Prettier-clean

`npm run check` runs `prettier --check .`. The big generated SVG is not hand-edited,
so keep `assets/architecture.svg` in `.prettierignore` alongside `assets/statusline.svg`.

## Home of the long-form

Per `CLAUDE.md` ("docs live in GitHub"), the rationale and debate live in the `Design`
Discussion ([#46](https://github.com/dezeat/claude-usage-meter/discussions/46)).
`docs/architecture.md` is the in-repo, release-facing snapshot and cross-links it; the
prose architecture in `CLAUDE.md` remains the in-context constraint.
