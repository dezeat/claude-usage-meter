import { paint } from "./ansi.js";
import { humanTokens } from "./format.js";
import {
  type ClassCount,
  type CrossSessionIndex,
  monthClassSpend,
  monthOf,
  sessionTotals,
  sumTokens,
} from "./index-store.js";

export const LIVENESS_WINDOW_MS = 5 * 60 * 1000;

function sortClassCounts(counts: Map<string, number>): ClassCount[] {
  return Array.from(counts, ([cls, count]) => ({ cls, count })).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.cls.localeCompare(b.cls);
  });
}

// Sessions in the given calendar month, counted per class. A session's month is
// derived from its lastTs through monthOf, matching the stored `month` column —
// so this render-side tally equals the SQL aggregation in the store.
export function monthClassCounts(
  sessions: CrossSessionIndex["sessions"],
  month: string,
): ClassCount[] {
  const counts = new Map<string, number>();
  for (const rec of Object.values(sessions)) {
    if (monthOf(rec.lastTs) !== month) continue;
    counts.set(rec.modelClass, (counts.get(rec.modelClass) ?? 0) + 1);
  }
  return sortClassCounts(counts);
}

// Sessions live right now (lastTs within the liveness window of nowMs), counted
// per class. Independent of month scope: a session active across a month
// boundary still counts here. excludeSessionId drops the current session so the
// live tally reads "besides you" — two live opus, one of them this session,
// renders opus 1.
export function liveClassCounts(
  sessions: CrossSessionIndex["sessions"],
  nowMs: number,
  excludeSessionId?: string,
): ClassCount[] {
  const counts = new Map<string, number>();
  for (const rec of Object.values(sessions)) {
    if (nowMs - rec.lastTs >= LIVENESS_WINDOW_MS) continue;
    if (excludeSessionId !== undefined && rec.sessionId === excludeSessionId)
      continue;
    counts.set(rec.modelClass, (counts.get(rec.modelClass) ?? 0) + 1);
  }
  return sortClassCounts(counts);
}

// The fleet row cells (board section 1): a count cell — the active class's
// month session count over the month grand total as `mdl <current>/<total>`
// (the dim `mdl` label, the ratio bright) — followed, only when another session
// is live, by an `active` cell tallying live sessions per class as
// `active ● <class> <n> …`. The current session is excluded from the live tally
// (it is "besides you"), so the active cell vanishes when nothing else is live.
export function renderRoster(
  index: CrossSessionIndex,
  currentClass: string,
  month: string,
  nowMs: number,
  color: boolean,
  excludeSessionId?: string,
): string[] {
  const monthCounts = monthClassCounts(index.sessions, month);
  const total = monthCounts.reduce((sum, c) => sum + c.count, 0);

  const currentCount =
    monthCounts.find((c) => c.cls === currentClass)?.count ?? 0;

  const countCell = `${paint("mdl", "dim", color)} ${paint(
    `${currentCount}/${total}`,
    "brightWhite",
    color,
  )}`;

  const live = liveClassCounts(index.sessions, nowMs, excludeSessionId);
  if (live.length === 0) return [countCell];

  const liveLabel = paint("active", "dim", color);
  const liveCells = live
    .map(
      (c) =>
        `${paint("●", "green", color)} ${paint(`${c.cls} ${c.count}`, "brightWhite", color)}`,
    )
    .join(" ");
  return [countCell, `${liveLabel} ${liveCells}`];
}

export interface MonthlySpend {
  active: string;
  total: string;
}

// The active class's accumulated spend this month and the month Σ total, as two
// cost-forward spend-row cells (`<label> $<cost> <tokens>`): the dim label, the
// bright cost, the dim token count. The active cell's literal label is `mdl`
// (not the class name), Σ counts every class including ones not shown
// individually. A zero for the active class is meaningful (nothing spent on it
// yet this month), so it renders `mdl $0.00 0` rather than being omitted.
export function renderMonthly(
  indexPath: string,
  activeClass: string,
  month: string,
  color: boolean,
): MonthlySpend {
  const spend = monthClassSpend(indexPath, month);
  const active = spend.byClass[activeClass] ?? { tokens: 0, costUsd: 0 };

  return {
    active: costForward(
      "mdl",
      active.costUsd,
      humanTokens(active.tokens),
      color,
    ),
    total: costForward(
      "Σ",
      spend.total.costUsd,
      humanTokens(spend.total.tokens),
      color,
    ),
  };
}

// One cost-forward spend cell: dim label · bright `$cost` · dim tokens.
function costForward(
  label: string,
  costUsd: number,
  tokens: string,
  color: boolean,
): string {
  return `${paint(label, "dim", color)} ${paint(
    `$${costUsd.toFixed(2)}`,
    "brightWhite",
    color,
  )} ${paint(tokens, "dim", color)}`;
}

interface SessionRef {
  sessionId?: string;
  transcriptPath?: string;
}

function renderSpend(
  index: CrossSessionIndex,
  sessionCostUsd: number | undefined,
  session: SessionRef,
  color: boolean,
): string {
  const totals = sessionTotals(
    index,
    session.sessionId,
    session.transcriptPath,
  );
  // Cost-forward: dim `ses` · bright `$cost` · dim tokens. Absence in the store
  // (not yet indexed this render) means cost-only; never print 0 tokens. With
  // neither tokens nor a session cost the whole cell is omitted.
  if (totals !== undefined) {
    return costForward(
      "ses",
      totals.costUsd,
      humanTokens(sumTokens(totals.tokens)),
      color,
    );
  }
  if (sessionCostUsd !== undefined) {
    return `${paint("ses", "dim", color)} ${paint(
      `$${sessionCostUsd.toFixed(2)}`,
      "brightWhite",
      color,
    )}`;
  }
  return "";
}

export interface FleetCells {
  spendCells: string[];
  fleetCells: string[];
}

// The spend and fleet row cells (board section 1), already painted but WITHOUT
// field separators — the line assembler joins them with the shared dot
// separator. spendCells = the live session cell (omitted when neither tokens
// nor a session cost is known), the active class's month spend, the Σ month
// total. fleetCells come from the roster. The current session is threaded
// through so the live `active` tally excludes it.
export function renderFleet(
  index: CrossSessionIndex,
  indexPath: string,
  currentClass: string,
  sessionCostUsd: number | undefined,
  month: string,
  nowMs: number,
  color: boolean,
  session: SessionRef = {},
): FleetCells {
  const monthly = renderMonthly(indexPath, currentClass, month, color);
  const sesCell = renderSpend(index, sessionCostUsd, session, color);

  const spendCells: string[] = [];
  if (sesCell !== "") spendCells.push(sesCell);
  spendCells.push(monthly.active, monthly.total);

  return {
    spendCells,
    fleetCells: renderRoster(
      index,
      currentClass,
      month,
      nowMs,
      color,
      session.sessionId,
    ),
  };
}
