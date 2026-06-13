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
// boundary still counts here.
export function liveClassCounts(
  sessions: CrossSessionIndex["sessions"],
  nowMs: number,
): ClassCount[] {
  const counts = new Map<string, number>();
  for (const rec of Object.values(sessions)) {
    if (nowMs - rec.lastTs >= LIVENESS_WINDOW_MS) continue;
    counts.set(rec.modelClass, (counts.get(rec.modelClass) ?? 0) + 1);
  }
  return sortClassCounts(counts);
}

// The fleet row (board section 1): the active class's session count this month
// against the month grand total, then how many sessions are live right now per
// class. `<activeClass> <classCount>·<monthTotal> mo` · `live <●n class …>`.
// The count head is bright when the active class has a live session, else dim;
// the trailing ` mo` qualifier is always dim. The live segment is omitted when
// nothing is live.
export function renderRoster(
  index: CrossSessionIndex,
  currentClass: string,
  month: string,
  nowMs: number,
  color: boolean,
): string {
  const monthCounts = monthClassCounts(index.sessions, month);
  const total = monthCounts.reduce((sum, c) => sum + c.count, 0);

  const live = liveClassCounts(index.sessions, nowMs);
  const liveByClass = new Map(live.map((c) => [c.cls, c.count]));

  const currentCount =
    monthCounts.find((c) => c.cls === currentClass)?.count ?? 0;
  const currentLive = (liveByClass.get(currentClass) ?? 0) > 0;

  const head = paint(
    `${currentClass} ${currentCount}`,
    currentLive ? "brightWhite" : "dim",
    color,
  );
  const tail = paint(`·${total} mo`, "dim", color);
  const count = `${head}${tail}`;

  if (live.length === 0) return count;

  const liveLabel = paint("live", "dim", color);
  const liveCells = live
    .map((c) => paint(`●${c.count} ${c.cls}`, "brightWhite", color))
    .join(" ");
  return `${count}  ${liveLabel} ${liveCells}`;
}

export interface MonthlySpend {
  active: string;
  total: string;
}

// The active class's accumulated spend this month and the month Σ total, as two
// separate spend-row cells so the row assembler can space them. The active-class
// figure is DIM — it is the period accumulation, not the live session. Σ counts
// every class for the month, including ones not shown individually. A zero for
// the active class is meaningful (nothing spent on it yet this month), so it
// renders `0 $0.00` rather than being omitted.
export function renderMonthly(
  indexPath: string,
  activeClass: string,
  month: string,
  color: boolean,
): MonthlySpend {
  const spend = monthClassSpend(indexPath, month);
  const active = spend.byClass[activeClass] ?? { tokens: 0, costUsd: 0 };

  return {
    active: paint(
      `${activeClass} ${humanTokens(active.tokens)} $${active.costUsd.toFixed(2)}`,
      "dim",
      color,
    ),
    total: paint(
      `Σ ${humanTokens(spend.total.tokens)} $${spend.total.costUsd.toFixed(2)}`,
      "brightWhite",
      color,
    ),
  };
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
  // The current session is the live one — paint it bright, not dim. Absence in
  // the store (not yet indexed this render) means cost-only; never print 0 tokens.
  if (totals !== undefined) {
    return paint(
      `ses ${humanTokens(sumTokens(totals.tokens))} $${totals.costUsd.toFixed(2)}`,
      "brightWhite",
      color,
    );
  }
  if (sessionCostUsd !== undefined) {
    return paint(`ses $${sessionCostUsd.toFixed(2)}`, "brightWhite", color);
  }
  return "";
}

export interface FleetRows {
  spend: string;
  fleet: string;
}

const CELL_GAP = "  ";

// The spend and fleet row contents (board section 1), as two already-spaced
// strings the line assembler drops into labelled rows. spend = the live session
// cell · the active class's month spend · the Σ month total; fleet = the roster.
// The session cell is omitted when neither tokens nor a session cost is known.
export function renderFleet(
  index: CrossSessionIndex,
  indexPath: string,
  currentClass: string,
  sessionCostUsd: number | undefined,
  month: string,
  nowMs: number,
  color: boolean,
  session: SessionRef = {},
): FleetRows {
  const monthly = renderMonthly(indexPath, currentClass, month, color);
  const sesLabel = renderSpend(index, sessionCostUsd, session, color);

  const spendCells = [];
  if (sesLabel !== "") spendCells.push(sesLabel);
  spendCells.push(monthly.active, monthly.total);

  return {
    spend: spendCells.join(CELL_GAP),
    fleet: renderRoster(index, currentClass, month, nowMs, color),
  };
}
