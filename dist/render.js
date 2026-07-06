import { paint, padVisible } from "./ansi.js";
import { FIVE_HOUR_SECONDS, SEVEN_DAY_SECONDS, SHORT_BAR_WIDTH, contextBar, elapsedFraction, formatCountdown, formatResetDate, paceBar, } from "./bars.js";
import { renderFleet, sesCell } from "./fleet-render.js";
import { modelClass, } from "./index-store.js";
import {} from "./payload.js";
export const PLACEHOLDER_LINE = "usage-meter · waiting for data";
const ROW_LABELS = ["current", "limits", "spend", "fleet"];
const GUTTER = Math.max(...ROW_LABELS.map((l) => l.length));
// Join already-painted field cells with a two-tier separator: a dim middle-dot
// flanked by spaces. Empty cells are dropped so an absent field leaves no
// dangling separator. The same separator unifies every row.
function joinFields(cells, color) {
    const sep = ` ${paint("·", "dim", color)} `;
    return cells.filter((c) => c !== "").join(sep);
}
function renderLimit(label, window, windowSeconds, now, color, showResetDate = false) {
    const fraction = elapsedFraction(window.resetsAt, windowSeconds, now);
    const bar = paceBar(window.usedPercentage, fraction, color, SHORT_BAR_WIDTH);
    const percentage = `${Math.round(window.usedPercentage)}%`;
    const remainingSeconds = window.resetsAt - now.getTime() / 1000;
    // The 7d window resets days out, so its absolute day ("Tue 16.06") is the
    // anchor the relative countdown lacks; the 5h window is same-day and omits it.
    const absolute = showResetDate
        ? ` (${formatResetDate(window.resetsAt)})`
        : "";
    const reset = paint(`⟳ ${formatCountdown(remainingSeconds)}${absolute}`, "dim", color);
    return `${label} ${bar} ${percentage} ${reset}`;
}
function limitsCells(payload, limits, now, color) {
    const cells = [];
    // ctx is legitimately per-session, so it always renders from the local payload.
    // The 5h/7d windows are account-wide: prefer the freshest cross-session window
    // resolved at the edge, falling back to this session's own payload snapshot.
    const fiveHour = limits?.fiveHour ?? payload.fiveHour;
    const sevenDay = limits?.sevenDay ?? payload.sevenDay;
    if (payload.contextPercentage !== undefined) {
        const bar = contextBar(payload.contextPercentage, color, SHORT_BAR_WIDTH);
        cells.push(`ctx ${bar} ${Math.round(payload.contextPercentage)}%`);
    }
    if (fiveHour) {
        cells.push(renderLimit("5h", fiveHour, FIVE_HOUR_SECONDS, now, color));
    }
    if (sevenDay) {
        cells.push(renderLimit("7d", sevenDay, SEVEN_DAY_SECONDS, now, color, true));
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
function currentCells(payload, location, color) {
    const cells = [];
    if (payload.modelName !== undefined) {
        cells.push(paint(payload.modelName.toLowerCase(), "brightWhite", color));
    }
    if (location !== undefined) {
        let cell = paint(location.name, "brightWhite", color);
        if (location.branch !== undefined) {
            cell += ` ${paint("⎇", "dim", color)} ${location.branch}`;
        }
        // A dim ⌂ + name trails the branch only inside a linked worktree, so two
        // worktrees of one repo are distinguishable; a normal checkout leaves the
        // cell byte-for-byte unchanged.
        if (location.worktree !== undefined) {
            cell += ` ${paint("⌂", "dim", color)} ${location.worktree}`;
        }
        cells.push(cell);
    }
    return cells;
}
function labelled(label, content, color) {
    return `${paint(padVisible(label, GUTTER), "accent", color)}  ${content}`;
}
export function renderLine(payload, now, options = {}) {
    const color = options.color ?? true;
    const rows = [];
    const currentRow = joinFields(currentCells(payload, options.location, color), color);
    if (currentRow !== "")
        rows.push(labelled("current", currentRow, color));
    const limits = joinFields(limitsCells(payload, options.limits, now, color), color);
    if (limits !== "")
        rows.push(labelled("limits", limits, color));
    const index = options.index ?? null;
    if (index !== null) {
        const month = now.toISOString().slice(0, 7);
        const { spendCells, fleetCells } = renderFleet(index, options.indexPath ?? "", activeClass(payload), payload.costUsd, payload.durationMs, month, now.getTime(), color, { sessionId: payload.sessionId, transcriptPath: payload.transcriptPath });
        const spend = joinFields(spendCells, color);
        const fleet = joinFields(fleetCells, color);
        if (spend !== "")
            rows.push(labelled("spend", spend, color));
        if (fleet !== "")
            rows.push(labelled("fleet", fleet, color));
    }
    else if (payload.costUsd !== undefined) {
        // No store this render: the payload cost is the live session's authority
        // (ADR-0004), cost-only (no token totals available without the index, so no
        // cache% cell). The burn rate still renders when the payload carries a
        // duration.
        const ses = sesCell(payload.costUsd, payload.durationMs, color);
        rows.push(labelled("spend", ses, color));
    }
    if (rows.length === 0) {
        return labelled("current", paint(payload.modelName ?? "Claude", "dim", color), color);
    }
    return rows.join("\n");
}
