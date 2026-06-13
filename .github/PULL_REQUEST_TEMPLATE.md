## What & why

What this changes and the motivation.

## Checklist

- [ ] `npm run check` is green (typecheck + lint + format + build + tests)
- [ ] `dist/` rebuilt and staged if `src/` changed
- [ ] Behaviour changes are covered by a test whose expectation comes from an
      external oracle (not from running the implementation)
- [ ] Pricing changes bump `asOf` in `src/pricing.ts`
- [ ] Conventional Commit title (`feat:`, `fix:`, `docs:`, …)

## Notes

Anything reviewers should know — trade-offs, follow-ups, screenshots.
