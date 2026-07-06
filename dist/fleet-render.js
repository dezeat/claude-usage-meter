import { paint } from "./ansi.js";
import { burnRate, cacheReadShare, formatUsd, sumUsage } from "./format.js";
import { monthClassSpend, monthOf, sessionTotals, } from "./index-store.js";
import {} from "./layout.js";
export const LIVENESS_WINDOW_MS = 5 * 60 * 1000;
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
// The fleet row cells (board section 1): a count cell — the active class's month
// session count, a Σ connective, then the month grand total across all classes:
// `<current> Σ <total>`. The Σ is dim (a quiet connective, matching the Σ on the
// spend row); the two counts are bright. The current row already names the active
// model, so the count cell carries no self-tag. Followed, only when another
// session is live, by a roster cell tallying live sessions per class as
// `● <class> <n> …`. The current session is excluded from the live tally (it is
// "besides you"), so the roster cell vanishes when nothing else is live.
// The `<current> Σ <total>` count cell: the active class's month count, a dim Σ
// connective, then the month grand total. Shared by the block roster and the
// single-line HUD so the two presentations can't drift.
function countCell(monthCounts, currentClass, color) {
    const total = monthCounts.reduce((sum, c) => sum + c.count, 0);
    const current = monthCounts.find((c) => c.cls === currentClass)?.count ?? 0;
    return `${paint(`${current}`, "brightWhite", color)} ${paint("Σ", "dim", color)} ${paint(`${total}`, "brightWhite", color)}`;
}
// The live roster: `● <class> <n>` per live class, space-joined.
function rosterCell(live, color) {
    return live
        .map((c) => `${paint("●", "green", color)} ${paint(`${c.cls} ${c.count}`, "brightWhite", color)}`)
        .join(" ");
}
export function renderRoster(index, currentClass, month, nowMs, color, excludeSessionId) {
    const monthCounts = monthClassCounts(index.sessions, month);
    const count = countCell(monthCounts, currentClass, color);
    const live = liveClassCounts(index.sessions, nowMs, excludeSessionId);
    if (live.length === 0)
        return [count];
    return [count, rosterCell(live, color)];
}
// The month Σ ledger cell for the spend row (ADR-0006): `Σ $<total> mo`, painted
// wholly dim — the accumulated month total recedes below the live `ses`/burn/
// cache figures, since brightness encodes "what is moving". The per-class `mdl`
// cost cell was dropped: the month total is the one accumulated figure worth a
// glance, and the current row already names the active model.
export function renderMonthly(indexPath, month, color) {
    const spend = monthClassSpend(indexPath, month);
    return paint(`Σ ${formatUsd(spend.total.costUsd)} mo`, "dim", color);
}
// The live session spend cell: dim `ses` · bright `$cost`, then — when a burn
// rate is known (a positive duration) — an accent `↑`, the bright `$rate`, and a
// dim `/hr`. The token trail is gone (ADR-0006); the cache-read share now carries
// the efficiency signal in its own cell. Live figures are bright; the `/hr` unit
// recedes.
export function sesCell(costUsd, durationMs, color) {
    const cell = `${paint("ses", "dim", color)} ${paint(formatUsd(costUsd), "brightWhite", color)}`;
    const rate = durationMs === undefined ? undefined : burnRate(costUsd, durationMs);
    if (rate === undefined)
        return cell;
    return `${cell} ${paint("↑", "accent", color)}${paint(formatUsd(rate), "brightWhite", color)}${paint("/hr", "dim", color)}`;
}
// The cache-read-share cell: bright `<pct>%` · dim `cached` — the efficiency
// signal that explains a low `ses` cost (agentic usage is cache-read-dominated,
// and a cache read is far cheaper than fresh output). Callers omit the cell when
// tokens are unknown, so it never prints a meaningless 0%.
function cacheCell(pct, color) {
    return `${paint(`${pct}%`, "brightWhite", color)} ${paint("cached", "dim", color)}`;
}
// The one-line HUD's compact cache cell: bright `<pct>%` · dim `c`. The HUD is
// width-bound, so it trades the `cached` word for a single-letter suffix (`96%c`);
// the roomier block layout keeps the spelled-out `cacheCell` above.
function cacheCellCompact(pct, color) {
    return `${paint(`${pct}%`, "brightWhite", color)}${paint("c", "dim", color)}`;
}
function renderSpend(index, sessionCostUsd, durationMs, session, color) {
    const totals = sessionTotals(index, session.sessionId, session.transcriptPath);
    // The two-cost-source rule (ADR-0004): when the session is in the store its
    // pricing-table cost is authoritative (the branch below), and its own tokens
    // yield the cache% cell; only the not-yet-indexed live session falls back to
    // the payload's `cost.total_cost_usd`, which carries no tokens (no cache cell).
    if (totals !== undefined) {
        return {
            ses: sesCell(totals.costUsd, durationMs, color),
            share: cacheReadShare(sumUsage(totals.tokens)),
        };
    }
    if (sessionCostUsd !== undefined) {
        return {
            ses: sesCell(sessionCostUsd, durationMs, color),
            share: undefined,
        };
    }
    return { ses: "", share: undefined };
}
// The spend and fleet row cells (board section 1), already painted but WITHOUT
// field separators — the line assembler joins them with the shared dot
// separator. spendCells = the live `ses` cell (with burn rate when a duration is
// known; omitted when neither tokens nor a session cost is available), the
// cache% cell (only when the session's tokens are known), and the dim Σ month
// ledger. fleetCells come from the roster. The current session is threaded
// through so the live roster tally excludes it.
export function renderFleet(index, indexPath, currentClass, sessionCostUsd, durationMs, month, nowMs, color, session = {}) {
    const total = renderMonthly(indexPath, month, color);
    const { ses, share } = renderSpend(index, sessionCostUsd, durationMs, session, color);
    const spendCells = [];
    if (ses !== "")
        spendCells.push(ses);
    if (share !== undefined)
        spendCells.push(cacheCell(share, color));
    spendCells.push(total);
    return {
        spendCells,
        fleetCells: renderRoster(index, currentClass, month, nowMs, color, session.sessionId),
    };
}
// The spend and fleet cells as HUD segments carrying their shed priorities
// (ADR-0007 drop order): the dim Σ month ledger goes first (1), the count cell
// second (2 — the live roster outlives it), the cache% cell fifth (5), and the
// roster collapses to a bare `●<N>` last (6). The `ses` cell is load-bearing and
// carries no priority. Same figures as renderFleet, tagged for the shedder.
export function fleetLineSegments(index, indexPath, currentClass, sessionCostUsd, durationMs, month, nowMs, color, session = {}) {
    const total = renderMonthly(indexPath, month, color);
    const { ses, share } = renderSpend(index, sessionCostUsd, durationMs, session, color);
    const spend = [];
    if (ses !== "")
        spend.push({ text: ses });
    if (share !== undefined)
        spend.push({ text: cacheCellCompact(share, color), priority: 5 });
    spend.push({ text: total, priority: 1 });
    const monthCounts = monthClassCounts(index.sessions, month);
    const fleet = [
        { text: countCell(monthCounts, currentClass, color), priority: 2 },
    ];
    const live = liveClassCounts(index.sessions, nowMs, session.sessionId);
    if (live.length > 0) {
        const liveTotal = live.reduce((sum, c) => sum + c.count, 0);
        fleet.push({
            text: rosterCell(live, color),
            reduced: `${paint("●", "green", color)}${paint(`${liveTotal}`, "brightWhite", color)}`,
            priority: 6,
        });
    }
    return { spend, fleet };
}
