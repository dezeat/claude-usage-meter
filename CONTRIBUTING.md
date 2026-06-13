# Contributing

Thanks for your interest in claude-usage-meter. It's a small, deliberately
focused tool — contributions that keep it that way are very welcome.

## Ground rules

- **Zero runtime dependencies.** The only allowed runtime dependency is the Node
  built-in `node:sqlite`. No `better-sqlite3`, no network calls, no telemetry —
  these are design constraints, not preferences.
- **Node ≥ 22.5** (`node:sqlite`).
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:`), one logical change per commit.

## Development

```bash
npm install
npm run check    # typecheck + lint + format check + build + tests — must be green
```

- `npm run build` → `dist/` (runtime only; **this is the committed artifact**, so
  rebuild and stage `dist/` when you change `src/`).
- `npm test` compiles to `dist-test/` (git-ignored) and runs the Node built-in
  test runner.
- `claude plugin validate . --strict` validates the plugin and marketplace
  manifests.

The pre-commit hook runs lint-staged + typecheck; pre-push runs the full
`npm run check`. CI runs `npm run check` on Node 22.5, 22, and 24.

## Tests

Behaviour changes are test-first (red → green → refactor): write the failing
test first, then implement. **Fixture expectations come from an external oracle**
(published values, a reference tool, or a maintainer) — never from running the
implementation under test. Test names should state the invariant, not the
function called.

## Updating prices

Pricing is a hand-maintained table in [`src/pricing.ts`](src/pricing.ts) — this
is the most common and most welcome contribution. When rates change:

1. Update the relevant `ModelRates` (and add new models as needed).
2. **Bump the `asOf` date** so the staleness is visible to users.
3. Update or add a test in `src/pricing.test.ts` with the expected cost, derived
   from the published rate card (the oracle).

Unknown model ids are intentionally costed at `0`, flagged, and excluded from the
total rather than guessed — please preserve that behaviour.

## Pull requests

- Keep PRs small and single-purpose.
- Make sure `npm run check` is green and `dist/` is rebuilt if `src/` changed.
- Describe what changed and why; link any related issue.
