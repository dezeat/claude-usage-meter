import { type CostByModel, type PricingTable } from "./pricing.js";
import { type UsageByModel } from "./aggregate.js";
import { cacheReadShare, sumUsage, tokenBreakdown } from "./format.js";

function box(lines: string[]): string {
  const width = Math.max(...lines.map((line) => line.length));
  const horizontal = "─".repeat(width + 2);
  const framed = lines.map((line) => `│ ${line.padEnd(width)} │`);
  return [`┌${horizontal}┐`, ...framed, `└${horizontal}┘`].join("\n");
}

export function renderSummary(
  usage: UsageByModel,
  costs: CostByModel,
  table: PricingTable,
): string {
  const lines: string[] = ["usage-meter · session (API-equivalent)", ""];

  for (const entry of costs.perModel) {
    const modelUsage = usage.models[entry.model];
    const tokens = modelUsage ? tokenBreakdown(modelUsage) : "";
    const amount = entry.known
      ? `$${entry.costUsd.toFixed(2)}`
      : "no pricing ⚠";
    lines.push(`${entry.model}  ${amount}`);
    lines.push(`  ${tokens}`);
  }

  // Session-total split under the total cost — the same four-way breakdown,
  // summed across models, with the cache-read share that explains why the
  // dollar figure is so far below token-count × output-rate.
  const total = sumUsage(usage.models);
  const share = cacheReadShare(total);
  lines.push("");
  lines.push(`total  $${costs.totalUsd.toFixed(2)}`);
  lines.push(
    `  ${tokenBreakdown(total)}` +
      (share === undefined ? "" : `  (${share}% cache reads)`),
  );
  if (costs.hasUnknownModels) {
    lines.push("(total excludes ⚠ unpriced models)");
  }
  lines.push(`pricing asOf ${table.asOf}  ·  oracle: npx ccusage`);

  return box(lines);
}
