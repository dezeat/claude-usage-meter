import { paint } from "./ansi.js";
import { formatUsd, sumUsage, tokenTrail } from "./format.js";
import { monthClassSpend, monthOf, sessionTotals, } from "./index-store.js";
export const LIVENESS_WINDOW_MS = 5 * 60 * 1000;
// The active model's own class is named on the `now` row ("opus 4.8"), so the
// rows below it would only repeat that identity. They use this neutral self-tag
// instead — "this model" — freeing the real class names for the live `active ●`
// tally, where they distinguish *other* sessions' models.
export const SELF_LABEL = "mdl";
function sortClassCounts(counts) {
    return Array.from(counts, ([cls, count]) => ({ cls, count })).sort((a, b) => {
        if (b.count !== a.count)
            return b.count - a.count;
        return a.cls.localeCompare(b.cls);
    });
}
// Sessions in the given calendar month, counted per class. A session's month is
// derived from its lastTs through monthOf, matching the stored `month` column —
// so this render-side tally equals the SQL aggregation in the store.
export function monthClassCounts(sessions, month) {
    const counts = new Map();
    for (const rec of Object.values(sessions)) {
        // A subagent transcript is not a session — its spend is credited to the parent
        // (ADR-0001), so it never adds to the per-class session count.
        if (rec.parentSessionId !== undefined)
            continue;
        if (monthOf(rec.lastTs) !== month)
            continue;
        counts.set(rec.modelClass, (counts.get(rec.modelClass) ?? 0) + 1);
    }
    return sortClassCounts(counts);
}
// Sessions live right now (lastTs within the liveness window of nowMs), counted
// per class. Independent of month scope: a session active across a month
// boundary still counts here. excludeSessionId drops the current session so the
// live tally reads "besides you" — two live opus, one of them this session,
// renders opus 1.
export function liveClassCounts(sessions, nowMs, excludeSessionId) {
    const counts = new Map();
    for (const rec of Object.values(sessions)) {
        // Subagents aren't live sessions of their own (ADR-0001) — skip child records.
        if (rec.parentSessionId !== undefined)
            continue;
        if (nowMs - rec.lastTs >= LIVENESS_WINDOW_MS)
            continue;
        if (excludeSessionId !== undefined && rec.sessionId === excludeSessionId)
            continue;
        counts.set(rec.modelClass, (counts.get(rec.modelClass) ?? 0) + 1);
    }
    return sortClassCounts(counts);
}
// The fleet row cells (board section 1): a count cell — the neutral self-tag
// (`mdl`, since the current row already names the active model), the active class's
// month session count, a Σ connective, then the month grand total across all
// classes: `mdl <current> Σ <total>`. The self-tag and the Σ are dim (the Σ
// reads as a quiet connective, matching the Σ on the spend row); the two counts
// are bright. Followed, only when another
// session is live, by an `active` cell tallying live sessions per class as
// `active ● <class> <n> …`. The current session is excluded from the live tally
// (it is "besides you"), so the active cell vanishes when nothing else is live.
export function renderRoster(index, currentClass, month, nowMs, color, excludeSessionId) {
    const monthCounts = monthClassCounts(index.sessions, month);
    const total = monthCounts.reduce((sum, c) => sum + c.count, 0);
    const currentCount = monthCounts.find((c) => c.cls === currentClass)?.count ?? 0;
    const countCell = `${paint(SELF_LABEL, "dim", color)} ${paint(`${currentCount}`, "brightWhite", color)} ${paint("Σ", "dim", color)} ${paint(`${total}`, "brightWhite", color)}`;
    const live = liveClassCounts(index.sessions, nowMs, excludeSessionId);
    if (live.length === 0)
        return [countCell];
    const liveLabel = paint("active", "dim", color);
    const liveCells = live
        .map((c) => `${paint("●", "green", color)} ${paint(`${c.cls} ${c.count}`, "brightWhite", color)}`)
        .join(" ");
    return [countCell, `${liveLabel} ${liveCells}`];
}
// The active class's accumulated spend this month and the month Σ total, as two
// cost-forward spend-row cells (`<label> $<cost> <tokens>`): the dim label, the
// bright cost, the dim i|c|o trail (ADR-0005). The active cell is labelled with the neutral
// self-tag (`mdl`); Σ counts every class including ones not shown individually. A
// zero for the active class is meaningful (nothing spent on it yet this month),
// so it renders `mdl $0.00 0` rather than being omitted.
export function renderMonthly(indexPath, activeClass, month, color) {
    const spend = monthClassSpend(indexPath, month);
    // Look up by the real class; render under the neutral self-tag (the current
    // row already names the model). A Σ over every class follows.
    const active = spend.byClass[activeClass] ?? {
        tokens: sumUsage({}),
        costUsd: 0,
    };
    return {
        active: costForward(SELF_LABEL, active.costUsd, color, tokenTrail(active.tokens)),
        total: costForward("Σ", spend.total.costUsd, color, tokenTrail(spend.total.tokens)),
    };
}
// One cost-forward spend cell: dim label · bright `$cost`, then dim tokens when
// known. Omitting `tokens` yields the cost-only cell — the live, not-yet-indexed
// `ses` fallback never prints a 0-token count, so there is no trailing tokens
// segment (and no trailing space).
export function costForward(label, costUsd, color, tokens) {
    const cell = `${paint(label, "dim", color)} ${paint(formatUsd(costUsd), "brightWhite", color)}`;
    return tokens === undefined ? cell : `${cell} ${paint(tokens, "dim", color)}`;
}
function renderSpend(index, sessionCostUsd, session, color) {
    const totals = sessionTotals(index, session.sessionId, session.transcriptPath);
    // Cost-forward: dim `ses` · bright `$cost` · dim tokens. Absence in the store
    // (not yet indexed this render) means cost-only; never print 0 tokens. With
    // neither tokens nor a session cost the whole cell is omitted.
    //
    // The two-cost-source rule (ADR-0004): when the session is in the store its
    // pricing-table cost is authoritative (the branch below); only the not-yet-
    // indexed live session falls back to the payload's `cost.total_cost_usd`.
    if (totals !== undefined) {
        return costForward("ses", totals.costUsd, color, tokenTrail(sumUsage(totals.tokens)));
    }
    // Live fallback: payload cost (ADR-0004), cost-only — omit tokens.
    if (sessionCostUsd !== undefined) {
        return costForward("ses", sessionCostUsd, color);
    }
    return "";
}
// The spend and fleet row cells (board section 1), already painted but WITHOUT
// field separators — the line assembler joins them with the shared dot
// separator. spendCells = the live session cell (omitted when neither tokens
// nor a session cost is known), the active class's month spend, the Σ month
// total. fleetCells come from the roster. The current session is threaded
// through so the live `active` tally excludes it.
export function renderFleet(index, indexPath, currentClass, sessionCostUsd, month, nowMs, color, session = {}) {
    const monthly = renderMonthly(indexPath, currentClass, month, color);
    const sesCell = renderSpend(index, sessionCostUsd, session, color);
    const spendCells = [];
    if (sesCell !== "")
        spendCells.push(sesCell);
    spendCells.push(monthly.active, monthly.total);
    return {
        spendCells,
        fleetCells: renderRoster(index, currentClass, month, nowMs, color, session.sessionId),
    };
}
