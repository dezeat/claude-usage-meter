import { type CostByModel, type PricingTable } from "./pricing.js";
import { type UsageByModel } from "./aggregate.js";

function humanTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

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
    const tokens = modelUsage
      ? `in ${humanTokens(modelUsage.inputTokens)}  out ${humanTokens(modelUsage.outputTokens)}  ` +
        `cache ${humanTokens(modelUsage.cacheReadTokens)}r/${humanTokens(modelUsage.cacheCreationTokens)}w`
      : "";
    const amount = entry.known
      ? `$${entry.costUsd.toFixed(2)}`
      : "no pricing ⚠";
    lines.push(`${entry.model}  ${amount}`);
    lines.push(`  ${tokens}`);
  }

  lines.push("");
  lines.push(`total  $${costs.totalUsd.toFixed(2)}`);
  if (costs.hasUnknownModels) {
    lines.push("(total excludes ⚠ unpriced models)");
  }
  lines.push(`pricing asOf ${table.asOf}  ·  oracle: npx ccusage`);

  return box(lines);
}
