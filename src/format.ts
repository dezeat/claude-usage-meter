import { type ModelUsage } from "./aggregate.js";

export function humanTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

// One place for the `$d.dd` cost spelling shared by every dollar figure
// (statusline, summary, report). Two-decimal fixed, no thousands separator —
// the format the tests pin and ccusage reconciles against.
export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

// Sum a per-model token map into one ModelUsage. Pure reducer shared by the
// report and summary breakdowns so every breakdown sums the four token kinds
// the same way — the same accounting ccusage reconciles against.
export function sumUsage(tokens: Record<string, ModelUsage>): ModelUsage {
  const total: ModelUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  for (const usage of Object.values(tokens)) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheCreationTokens += usage.cacheCreationTokens;
  }
  return total;
}

// The four-way input/output/cache-read/cache-create split on one line, the
// breakdown that makes a low dollar figure legible: agentic usage is
// cache-read-dominated, and a cache read is ~50× cheaper than output, so the
// cost sits far below token-count × output-rate. `cache R r / C w` reads as R
// read tokens and C written (created) tokens.
export function tokenBreakdown(usage: ModelUsage): string {
  return (
    `in ${humanTokens(usage.inputTokens)}` +
    ` · out ${humanTokens(usage.outputTokens)}` +
    ` · cache ${humanTokens(usage.cacheReadTokens)} r` +
    ` / ${humanTokens(usage.cacheCreationTokens)} w`
  );
}

// The cache-read share of all tokens, rounded to a whole percent — the single
// cue that explains a surprisingly-low cost ("96% cache reads"). Returns
// undefined when there are no tokens, so callers omit the cue rather than
// printing a meaningless 0%.
export function cacheReadShare(usage: ModelUsage): number | undefined {
  const total =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheCreationTokens;
  if (total === 0) return undefined;
  return Math.round((usage.cacheReadTokens / total) * 100);
}

// Live spend rate in dollars per hour. Returns undefined when the rate would be
// noise rather than signal: a zero/absent/non-finite duration (no elapsed time →
// a divide-by-zero Infinity), OR a non-positive cost — a `↑$0.00/hr` cue tells
// the user nothing and fires for any $0 session, e.g. one on an unknown model
// that prices to $0. Callers omit the cue rather than print it.
export function burnRate(
  costUsd: number,
  durationMs: number,
): number | undefined {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
  if (costUsd <= 0) return undefined;
  return costUsd / (durationMs / 3_600_000);
}
