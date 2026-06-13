import { paint } from "./ansi.js";
import { humanTokens } from "./format.js";
import { monthTotals, sumTokens, } from "./index-store.js";
const SPARKLINE_RAMP = "▁▂▃▄▅▆▇█";
const SPARKLINE_WIDTH = 8;
const MID_RAMP_CHAR = "▄";
function sparkline(series) {
    if (series.length === 0)
        return " ".repeat(SPARKLINE_WIDTH);
    const min = Math.min(...series);
    const max = Math.max(...series);
    const chars = series.map((v) => {
        if (min === max)
            return MID_RAMP_CHAR;
        const idx = Math.round(((v - min) / (max - min)) * 7);
        return SPARKLINE_RAMP[idx] ?? MID_RAMP_CHAR;
    });
    const padded = chars.join("").padEnd(SPARKLINE_WIDTH, " ");
    return padded;
}
function groupByDay(sessions, month) {
    const days = new Map();
    for (const rec of Object.values(sessions)) {
        if (rec.lastTs === 0)
            continue;
        const iso = new Date(rec.lastTs).toISOString();
        const date = iso.slice(0, 10);
        if (!date.startsWith(month))
            continue;
        const existing = days.get(date);
        if (existing === undefined) {
            const tokens = {};
            for (const [model, usage] of Object.entries(rec.tokens)) {
                tokens[model] = { ...usage };
            }
            days.set(date, { date, tokens, costUsd: rec.costUsd });
        }
        else {
            for (const [model, usage] of Object.entries(rec.tokens)) {
                const t = (existing.tokens[model] ??= {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheCreationTokens: 0,
                });
                t.inputTokens += usage.inputTokens;
                t.outputTokens += usage.outputTokens;
                t.cacheReadTokens += usage.cacheReadTokens;
                t.cacheCreationTokens += usage.cacheCreationTokens;
            }
            existing.costUsd += rec.costUsd;
        }
    }
    return Array.from(days.values()).sort((a, b) => a.date > b.date ? -1 : a.date < b.date ? 1 : 0);
}
function groupByModelClass(sessions, month) {
    const classes = new Map();
    for (const rec of Object.values(sessions)) {
        if (rec.lastTs === 0)
            continue;
        const date = new Date(rec.lastTs).toISOString().slice(0, 10);
        if (!date.startsWith(month))
            continue;
        const cls = rec.modelClass;
        const existing = classes.get(cls);
        const toks = sumTokens(rec.tokens);
        if (existing === undefined) {
            classes.set(cls, { costUsd: rec.costUsd, tokenCount: toks });
        }
        else {
            existing.costUsd += rec.costUsd;
            existing.tokenCount += toks;
        }
    }
    return Array.from(classes.entries())
        .map(([cls, v]) => ({ cls, ...v }))
        .sort((a, b) => b.costUsd - a.costUsd);
}
function formatDaySection(dayRows, color) {
    const lines = [];
    lines.push(paint("By day", "dim", color));
    lines.push(paint("──────", "dim", color));
    if (dayRows.length === 0) {
        lines.push(paint("  (no data)", "dim", color));
        return lines.join("\n");
    }
    const tokenSeries = dayRows.map((r) => sumTokens(r.tokens));
    const spark = sparkline(tokenSeries);
    const sparkChars = [...spark];
    const dateCw = 10;
    const tokCw = 9;
    const costCw = 7;
    for (const [i, row] of dayRows.entries()) {
        const dateCol = row.date.padEnd(dateCw);
        const barChar = sparkChars[i] ?? " ";
        // Pad the sparkline cell to two chars (ambiguous-width glyph rule)
        const barCell = `${barChar} `;
        const tokStr = humanTokens(sumTokens(row.tokens));
        const tokCol = `${tokStr} tok`.padStart(tokCw);
        const costStr = `$${row.costUsd.toFixed(2)}`.padStart(costCw);
        lines.push(paint(dateCol, "dim", color) +
            paint(barCell, "dim", color) +
            paint(tokCol, "dim", color) +
            paint("  ", "dim", color) +
            paint(costStr, "dim", color));
    }
    return lines.join("\n");
}
function formatModelClassSection(classCounts, color) {
    const lines = [];
    lines.push(paint("By model class", "dim", color));
    lines.push(paint("──────────────", "dim", color));
    if (classCounts.length === 0) {
        lines.push(paint("  (no data)", "dim", color));
        return lines.join("\n");
    }
    const clsCw = Math.max(6, ...classCounts.map((c) => c.cls.length)) + 2;
    const tokCw = 10;
    const costCw = 7;
    for (const row of classCounts) {
        const clsCol = row.cls.padEnd(clsCw);
        const tokStr = humanTokens(row.tokenCount);
        const tokCol = `${tokStr} tok`.padStart(tokCw);
        const costStr = `$${row.costUsd.toFixed(2)}`.padStart(costCw);
        lines.push(paint(clsCol, "dim", color) +
            paint(tokCol, "dim", color) +
            paint("  ", "dim", color) +
            paint(costStr, "dim", color));
    }
    return lines.join("\n");
}
function formatBranchSection(byBranch, color) {
    const lines = [];
    lines.push(paint("By branch", "dim", color));
    lines.push(paint("─────────", "dim", color));
    const entries = Object.entries(byBranch).sort(([, a], [, b]) => b.costUsd - a.costUsd);
    if (entries.length === 0) {
        lines.push(paint("  (no data)", "dim", color));
        return lines.join("\n");
    }
    const branchCw = Math.max(8, ...entries.map(([b]) => b.length)) + 2;
    const tokCw = 10;
    const costCw = 7;
    for (const [branch, totals] of entries) {
        const branchCol = branch.padEnd(branchCw);
        const tokStr = humanTokens(sumTokens(totals.tokens));
        const tokCol = `${tokStr} tok`.padStart(tokCw);
        const costStr = `$${totals.costUsd.toFixed(2)}`.padStart(costCw);
        lines.push(paint(branchCol, "dim", color) +
            paint(tokCol, "dim", color) +
            paint("  ", "dim", color) +
            paint(costStr, "dim", color));
    }
    return lines.join("\n");
}
export function formatReport(index, now, color) {
    const month = now.toISOString().slice(0, 7);
    const billing = monthTotals(index, month);
    const dayRows = groupByDay(index.sessions, month);
    const classCounts = groupByModelClass(index.sessions, month);
    const header = `Usage report — ${month}`;
    const rule = "═".repeat(header.length);
    const billingLine = `Billing period (${month}):` +
        `   ${humanTokens(sumTokens(billing.tokens))} tok` +
        `   $${billing.costUsd.toFixed(2)}`;
    const sections = [
        paint(header, "dim", color),
        paint(rule, "dim", color),
        "",
        formatDaySection(dayRows, color),
        "",
        formatModelClassSection(classCounts, color),
        "",
        formatBranchSection(index.byBranch, color),
        "",
        paint(billingLine, "brightWhite", color),
    ];
    return sections.join("\n");
}
