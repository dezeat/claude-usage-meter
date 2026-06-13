import { paint } from "./ansi.js";
import { type CrossSessionIndex, monthTotals } from "./index-store.js";

const LIVENESS_WINDOW_MS = 5 * 60 * 1000;

interface ClassCount {
  cls: string;
  count: number;
  live: boolean;
}

function classCounts(
  sessions: CrossSessionIndex["sessions"],
  nowMs: number,
): Map<string, ClassCount> {
  const counts = new Map<string, ClassCount>();
  for (const rec of Object.values(sessions)) {
    const cls = rec.modelClass;
    const live = nowMs - rec.lastTs < LIVENESS_WINDOW_MS;
    const existing = counts.get(cls);
    if (existing === undefined) {
      counts.set(cls, { cls, count: 1, live });
    } else {
      existing.count += 1;
      if (live) existing.live = true;
    }
  }
  return counts;
}

export function renderRoster(
  index: CrossSessionIndex,
  currentClass: string,
  nowMs: number,
  color: boolean,
): string {
  const counts = classCounts(index.sessions, nowMs);
  const total = Object.values(index.sessions).length;

  const current = counts.get(currentClass);
  const currentCount = current?.count ?? 0;
  const currentLive = current?.live ?? false;

  const anchor = paint(
    `⎇ ${currentCount}/${total} ${currentClass}`,
    currentLive ? "brightWhite" : "dim",
    color,
  );

  const others = Array.from(counts.values())
    .filter((c) => c.cls !== currentClass)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.cls.localeCompare(b.cls);
    })
    .map((c) => {
      const label = `${c.count} ${c.cls}`;
      return paint(label, c.live ? "brightWhite" : "dim", color);
    });

  if (others.length === 0) return anchor;
  return `${anchor} · ${others.join(" · ")}`;
}

export function renderMonthly(
  index: CrossSessionIndex,
  month: string,
  color: boolean,
): string {
  const totals = monthTotals(index, month);
  return paint(`mo $${totals.costUsd.toFixed(2)}`, "dim", color);
}

export function renderFleet(
  index: CrossSessionIndex,
  currentClass: string,
  sessionCostUsd: number | undefined,
  month: string,
  nowMs: number,
  color: boolean,
): string {
  const roster = renderRoster(index, currentClass, nowMs, color);
  const monthly = renderMonthly(index, month, color);

  const sesLabel =
    sessionCostUsd !== undefined
      ? paint(`ses $${sessionCostUsd.toFixed(2)}`, "dim", color)
      : "";

  const parts = [roster];
  if (sesLabel !== "") parts.push(sesLabel);
  parts.push(monthly);

  return parts.join("  ");
}
