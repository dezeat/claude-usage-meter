import { paint, padVisible } from "./ansi.js";
import { FIVE_HOUR_SECONDS, SEVEN_DAY_SECONDS, contextBar, elapsedFraction, formatCountdown, paceBar, } from "./bars.js";
import { renderFleet } from "./fleet-render.js";
import { modelClass } from "./index-store.js";
import {} from "./payload.js";
export const PLACEHOLDER_LINE = "usage-meter · waiting for data";
const ROW_LABELS = ["now", "limits", "spend", "fleet"];
const GUTTER = Math.max(...ROW_LABELS.map((l) => l.length));
// Join already-painted field cells with a two-tier separator: a dim middle-dot
// flanked by spaces. Empty cells are dropped so an absent field leaves no
// dangling separator. The same separator unifies every row.
function joinFields(cells, color) {
    const sep = ` ${paint("·", "dim", color)} `;
    return cells.filter((c) => c !== "").join(sep);
}
function renderLimit(label, window, windowSeconds, now, color) {
    const fraction = elapsedFraction(window.resetsAt, windowSeconds, now);
    const bar = paceBar(window.usedPercentage, fraction, color);
    const percentage = `${Math.round(window.usedPercentage)}%`;
    const remainingSeconds = window.resetsAt - now.getTime() / 1000;
    const reset = paint(`⟳ ${formatCountdown(remainingSeconds)}`, "dim", color);
    return `${label} ${bar} ${percentage} ${reset}`;
}
function limitsCells(payload, now, color) {
    const cells = [];
    if (payload.contextPercentage !== undefined) {
        const bar = contextBar(payload.contextPercentage, color);
        cells.push(`ctx ${bar} ${Math.round(payload.contextPercentage)}%`);
    }
    if (payload.fiveHour) {
        cells.push(renderLimit("5h", payload.fiveHour, FIVE_HOUR_SECONDS, now, color));
    }
    if (payload.sevenDay) {
        cells.push(renderLimit("7d", payload.sevenDay, SEVEN_DAY_SECONDS, now, color));
    }
    return cells;
}
// The active model class drives the spend/fleet scoping; derive it from the
// payload's model id, falling back to the display name. modelClass normalises
// either form to the stored class key ("opus" etc.) — passing the raw display
// name ("Opus 4.8") straight through would never match the stored "opus" key.
function activeClass(payload) {
    if (payload.modelId)
        return modelClass(payload.modelId);
    if (payload.modelName)
        return modelClass(payload.modelName.toLowerCase());
    return "unknown";
}
// The identity row: which model is running and where. Model display name is
// lowercased to sit in the same key as the dim class labels below ("opus 4.8",
// not "Opus 4.8"); the location is a bright repo/dir name with the branch after
// a dim ⎇ glyph (dropped outside a repo). Either cell may be absent — joinFields
// drops the empty one, and an empty row is omitted by the caller.
function nowCells(payload, location, color) {
    const cells = [];
    if (payload.modelName !== undefined) {
        cells.push(paint(payload.modelName.toLowerCase(), "brightWhite", color));
    }
    if (location !== undefined) {
        const name = paint(location.name, "brightWhite", color);
        cells.push(location.branch !== undefined
            ? `${name} ${paint("⎇", "dim", color)} ${location.branch}`
            : name);
    }
    return cells;
}
function labelled(label, content, color) {
    return `${paint(padVisible(label, GUTTER), "accent", color)}  ${content}`;
}
export function renderLine(payload, now, options = {}) {
    const color = options.color ?? true;
    const rows = [];
    const nowRow = joinFields(nowCells(payload, options.location, color), color);
    if (nowRow !== "")
        rows.push(labelled("now", nowRow, color));
    const limits = joinFields(limitsCells(payload, now, color), color);
    if (limits !== "")
        rows.push(labelled("limits", limits, color));
    const index = options.index ?? null;
    if (index !== null) {
        const month = now.toISOString().slice(0, 7);
        const { spendCells, fleetCells } = renderFleet(index, options.indexPath ?? "", activeClass(payload), payload.costUsd, month, now.getTime(), color, { sessionId: payload.sessionId, transcriptPath: payload.transcriptPath });
        const spend = joinFields(spendCells, color);
        const fleet = joinFields(fleetCells, color);
        if (spend !== "")
            rows.push(labelled("spend", spend, color));
        if (fleet !== "")
            rows.push(labelled("fleet", fleet, color));
    }
    else if (payload.costUsd !== undefined) {
        const ses = `${paint("ses", "dim", color)} ${paint(`$${payload.costUsd.toFixed(2)}`, "brightWhite", color)}`;
        rows.push(labelled("spend", ses, color));
    }
    if (rows.length === 0) {
        return labelled("now", paint(payload.modelName ?? "Claude", "dim", color), color);
    }
    return rows.join("\n");
}
