import {} from "./pricing.js";
import {} from "./aggregate.js";
import { cacheReadShare, formatUsd, sumUsage, tokenBreakdown, } from "./format.js";
function box(lines) {
    const width = Math.max(...lines.map((line) => line.length));
    const horizontal = "─".repeat(width + 2);
    const framed = lines.map((line) => `│ ${line.padEnd(width)} │`);
    return [`┌${horizontal}┐`, ...framed, `└${horizontal}┘`].join("\n");
}
export function renderSummary(usage, costs, table) {
    const lines = ["usage-meter · session (API-equivalent)", ""];
    for (const entry of costs.perModel) {
        const modelUsage = usage.models[entry.model];
        const tokens = modelUsage ? tokenBreakdown(modelUsage) : "";
        const amount = entry.known ? formatUsd(entry.costUsd) : "no pricing ⚠";
        lines.push(`${entry.model}  ${amount}`);
        lines.push(`  ${tokens}`);
    }
    // Session-total split under the total cost — the same four-way breakdown,
    // summed across models, with the cache-read share that explains why the
    // dollar figure is so far below token-count × output-rate.
    const total = sumUsage(usage.models);
    const share = cacheReadShare(total);
    lines.push("");
    lines.push(`total  ${formatUsd(costs.totalUsd)}`);
    lines.push(`  ${tokenBreakdown(total)}` +
        (share === undefined ? "" : `  (${share}% cache reads)`));
    if (costs.hasUnknownModels) {
        lines.push("(total excludes ⚠ unpriced models)");
    }
    lines.push(`pricing asOf ${table.asOf}  ·  oracle: npx ccusage`);
    return box(lines);
}
