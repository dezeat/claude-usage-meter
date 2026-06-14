# Security Policy

## Supply-chain posture

claude-usage-meter is built to be auditable end-to-end. The plugin makes **no
network call** and ships **zero runtime dependencies** — its only third-party
capability is the Node built-in `node:sqlite`. There is no telemetry, and no
data ever leaves your machine.

The CI supply chain is hardened with published GitHub and OpenSSF guidance:

- **SHA-pinned actions.** Every GitHub Action is pinned to a full-length commit
  SHA rather than a floating tag. A tag is mutable; a SHA is the immutable,
  auditable artifact. Dependabot still bumps the pinned SHAs (the `github-actions`
  ecosystem in `.github/dependabot.yml`), so pinning costs no freshness.
- **Least-privilege tokens.** Every workflow declares minimal `permissions`
  (`contents: read` by default), widening only where a job genuinely needs more
  — e.g. code scanning's `security-events: write`.
- **CodeQL code scanning** (`.github/workflows/codeql.yml`) runs on every push and
  pull request plus a weekly schedule.
- **Dependency review** (`.github/workflows/dependency-review.yml`) gates pull
  requests on known-vulnerable or disallowed-license dependency changes.
- **Secret scanning.** gitleaks scans the full git history on every push and pull
  request (`.github/workflows/security.yml`); a large-file guard runs pre-commit.
- **Production-dependency audit.** `npm audit --omit=dev` fails CI on any runtime
  advisory — a tripwire for a runtime dependency slipping into a zero-dep project.

These guards **complement** one another: gitleaks catches committed secrets,
CodeQL catches code-level vulnerabilities, dependency review catches risky
dependency changes, and the audit enforces the zero-runtime-dependency invariant.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a
vulnerability.

- Preferred: open a private report via GitHub Security Advisories —
  **Security → Report a vulnerability** on the repository
  (<https://github.com/dezeat/claude-usage-meter/security/advisories/new>).

Please include a description, reproduction steps, and the affected version or
commit. You can expect an initial acknowledgement within a few days. Once a fix
is available we will coordinate disclosure and credit you unless you prefer to
remain anonymous.
