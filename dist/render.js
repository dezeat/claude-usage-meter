import { paint, padVisible } from "./ansi.js";
import { FIVE_HOUR_SECONDS, SEVEN_DAY_SECONDS, SHORT_BAR_WIDTH, contextBar, elapsedFraction, formatCountdown, formatResetDate, paceBar, } from "./bars.js";
import { fleetLineSegments, renderFleet, sesCell } from "./fleet-render.js";
import { modelClass, } from "./index-store.js";
import { DROP, assembleLine, } from "./layout.js";
import { limitPill } from "./meters.js";
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
// The 5h/7d meter, the one place the bar/pill toggle branches: `bar` keeps the
// short pace bar plus its percentage (today's look); `pill` replaces both with a
// reverse-video severity chip. The reset countdown is composed by the caller and
// is unaffected either way.
function limitMeter(usedPercentage, paceFraction, color, meters) {
    if (meters === "pill")
        return limitPill(usedPercentage, color);
    const bar = paceBar(usedPercentage, paceFraction, color, SHORT_BAR_WIDTH);
    // Clamp the printed % to 100 so an over-limit window reads the same in bar and
    // pill mode (limitPill clamps too); the red fill already signals "over".
    return `${bar} ${Math.min(100, Math.round(usedPercentage))}%`;
}
// The ctx meter: same bar/pill toggle, but no pace marker (it uses contextBar).
function ctxCell(usedPercentage, color, meters) {
    if (meters === "pill")
        return `ctx ${limitPill(usedPercentage, color)}`;
    const bar = contextBar(usedPercentage, color, SHORT_BAR_WIDTH);
    return `ctx ${bar} ${Math.min(100, Math.round(usedPercentage))}%`;
}
// A limit cell split into its meter base (`5h ▓▓░ 52%`) and the dim reset trail
// (`⟳ 2h`): the block layout glues them back with a space, the HUD keeps the
// reset as the segment's droppable tail (ADR-0007, DROP.RESET).
function limitParts(label, window, windowSeconds, now, color, meters, showResetDate) {
    const fraction = elapsedFraction(window.resetsAt, windowSeconds, now);
    const meter = limitMeter(window.usedPercentage, fraction, color, meters);
    const base = `${label} ${meter}`;
    const remainingSeconds = window.resetsAt - now.getTime() / 1000;
    // The 7d window resets days out, so its absolute day ("Tue 16.06") is the
    // anchor the relative countdown lacks; the 5h window is same-day and omits it.
    const absolute = showResetDate
        ? ` (${formatResetDate(window.resetsAt)})`
        : "";
    const reset = paint(`⟳ ${formatCountdown(remainingSeconds)}${absolute}`, "dim", color);
    return { base, reset };
}
function renderLimit(label, window, windowSeconds, now, color, meters, showResetDate = false) {
    const { base, reset } = limitParts(label, window, windowSeconds, now, color, meters, showResetDate);
    return `${base} ${reset}`;
}
// ctx is legitimately per-session, so it always renders from the local payload.
// The 5h/7d windows are account-wide: prefer the freshest cross-session window
// resolved at the edge, falling back to this session's own payload snapshot.
function resolveWindows(payload, limits) {
    return {
        fiveHour: limits?.fiveHour ?? payload.fiveHour,
        sevenDay: limits?.sevenDay ?? payload.sevenDay,
    };
}
function limitsCells(payload, limits, now, color, meters) {
    const cells = [];
    const { fiveHour, sevenDay } = resolveWindows(payload, limits);
    if (payload.contextPercentage !== undefined) {
        cells.push(ctxCell(payload.contextPercentage, color, meters));
    }
    if (fiveHour) {
        cells.push(renderLimit("5h", fiveHour, FIVE_HOUR_SECONDS, now, color, meters));
    }
    if (sevenDay) {
        cells.push(renderLimit("7d", sevenDay, SEVEN_DAY_SECONDS, now, color, meters, true));
    }
    return cells;
}
// The limits row as HUD segments: ctx is load-bearing; each of 5h/7d carries its
// reset countdown as a droppable tail that reduces to the bare meter (DROP.RESET).
function limitsLineSegments(payload, limits, now, color, meters) {
    const segments = [];
    const { fiveHour, sevenDay } = resolveWindows(payload, limits);
    if (payload.contextPercentage !== undefined) {
        segments.push({ text: ctxCell(payload.contextPercentage, color, meters) });
    }
    for (const [label, window, seconds, showDate] of [
        ["5h", fiveHour, FIVE_HOUR_SECONDS, false],
        ["7d", sevenDay, SEVEN_DAY_SECONDS, true],
    ]) {
        if (!window)
            continue;
        const { base, reset } = limitParts(label, window, seconds, now, color, meters, showDate);
        segments.push({
            text: `${base} ${reset}`,
            reduced: base,
            priority: DROP.RESET,
        });
    }
    return segments;
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
// The location cell split into its bright repo/dir base and the full form with
// the dim ⎇ branch (and ⌂ worktree) tail appended. The HUD sheds the tail back
// to the base (ADR-0007, DROP.BRANCH); the block layout always shows the full form.
// A normal checkout with no branch/worktree leaves base === full byte-for-byte.
function locationParts(location, color) {
    const base = paint(location.name, "brightWhite", color);
    let full = base;
    if (location.branch !== undefined) {
        full += ` ${paint("⎇", "dim", color)} ${location.branch}`;
    }
    if (location.worktree !== undefined) {
        full += ` ${paint("⌂", "dim", color)} ${location.worktree}`;
    }
    return { base, full };
}
function currentCells(payload, location, color) {
    const cells = [];
    if (payload.modelName !== undefined) {
        cells.push(paint(payload.modelName.toLowerCase(), "brightWhite", color));
    }
    if (location !== undefined) {
        cells.push(locationParts(location, color).full);
    }
    return cells;
}
// The current row as HUD segments: the model and the repo name are load-bearing
// (the line "starts with the model"); only the ⎇ branch / ⌂ worktree tail is
// droppable (DROP.BRANCH).
function currentLineSegments(payload, location, color) {
    const segments = [];
    if (payload.modelName !== undefined) {
        segments.push({
            text: paint(payload.modelName.toLowerCase(), "brightWhite", color),
        });
    }
    if (location !== undefined) {
        const { base, full } = locationParts(location, color);
        segments.push({ text: full, reduced: base, priority: DROP.BRANCH });
    }
    return segments;
}
function labelled(label, content, color) {
    return `${paint(padVisible(label, GUTTER), "accent", color)}  ${content}`;
}
// The single-line HUD (ADR-0007): the same four rows built as tagged segments,
// folded into one never-wrapping line by layout.ts. Labels and newlines are
// dropped; segments shed by priority against `columns`.
function renderHud(payload, now, options, color, meters, index) {
    const rows = [
        currentLineSegments(payload, options.location, color),
        limitsLineSegments(payload, options.limits, now, color, meters),
    ];
    if (index !== null) {
        const month = now.toISOString().slice(0, 7);
        const { spend, fleet } = fleetLineSegments(index, options.indexPath ?? "", activeClass(payload), payload.costUsd, payload.durationMs, month, now.getTime(), color, { sessionId: payload.sessionId, transcriptPath: payload.transcriptPath }, options.livenessWindowMs);
        rows.push(spend, fleet);
    }
    else if (payload.costUsd !== undefined) {
        rows.push([{ text: sesCell(payload.costUsd, payload.durationMs, color) }]);
    }
    const line = assembleLine(rows, options.columns ?? Infinity, color);
    // Everything degraded to empty (no model, no location, no data): a bare dim
    // model name is still a valid single line — the HUD carries no row labels.
    if (line === "")
        return paint(payload.modelName ?? "Claude", "dim", color);
    return line;
}
export function renderLine(payload, now, options = {}) {
    const color = options.color ?? true;
    const layout = options.layout ?? "block";
    const meters = options.meters ?? "bar";
    const index = options.index ?? null;
    if (layout === "line") {
        return renderHud(payload, now, options, color, meters, index);
    }
    const rows = [];
    const currentRow = joinFields(currentCells(payload, options.location, color), color);
    if (currentRow !== "")
        rows.push(labelled("current", currentRow, color));
    const limits = joinFields(limitsCells(payload, options.limits, now, color, meters), color);
    if (limits !== "")
        rows.push(labelled("limits", limits, color));
    if (index !== null) {
        const month = now.toISOString().slice(0, 7);
        const { spendCells, fleetCells } = renderFleet(index, options.indexPath ?? "", activeClass(payload), payload.costUsd, payload.durationMs, month, now.getTime(), color, { sessionId: payload.sessionId, transcriptPath: payload.transcriptPath }, options.livenessWindowMs);
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
