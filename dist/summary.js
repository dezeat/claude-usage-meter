import {} from "./pricing.js";
import {} from "./aggregate.js";
import { humanTokens } from "./format.js";
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
