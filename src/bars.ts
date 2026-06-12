import { paint, type ColorName } from "./ansi.js";

const BAR_WIDTH = 8;
const FILLED = "▓";
const EMPTY = "░";
const MARKER = "│";

export const FIVE_HOUR_SECONDS = 5 * 60 * 60;
export const SEVEN_DAY_SECONDS = 7 * 24 * 60 * 60;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Fraction of the limit window already elapsed: 0 at window start, 1 at reset.
// resetsAt is Unix epoch seconds (the payload's unit); now is a Date.
export function elapsedFraction(
  resetsAt: number,
  windowSeconds: number,
  now: Date,
): number {
  const remainingSeconds = resetsAt - now.getTime() / 1000;
  return clamp(1 - remainingSeconds / windowSeconds, 0, 1);
}

// The marker sits at the even-pace position; filled cells at or past it are
// "overshoot" (burning faster than even) and render red. used >= 90 reddens
// the whole bar regardless of pace.
export function paceBar(
  usedPercentage: number,
  paceFraction: number,
  color: boolean,
): string {
  const used = clamp(usedPercentage, 0, 100);
  const fill = Math.round((used / 100) * BAR_WIDTH);
  const markerSlot = clamp(Math.round(paceFraction * BAR_WIDTH), 0, BAR_WIDTH);
  const severe = used >= 90;

  let out = "";
  for (let i = 0; i <= BAR_WIDTH; i++) {
    if (i === markerSlot) out += paint(MARKER, "brightWhite", color);
    if (i === BAR_WIDTH) break;
    if (i < fill) {
      const overshoot = i >= markerSlot;
      out += paint(FILLED, severe || overshoot ? "red" : "green", color);
    } else {
      out += paint(EMPTY, "dim", color);
    }
  }
  return out;
}

export function contextBar(usedPercentage: number, color: boolean): string {
  const used = clamp(usedPercentage, 0, 100);
  const fill = Math.round((used / 100) * BAR_WIDTH);
  const cellColor: ColorName =
    used >= 80 ? "red" : used >= 50 ? "yellow" : "green";

  let out = "";
  for (let i = 0; i < BAR_WIDTH; i++) {
    out +=
      i < fill ? paint(FILLED, cellColor, color) : paint(EMPTY, "dim", color);
  }
  return out;
}

export function formatCountdown(secondsUntil: number): string {
  if (secondsUntil <= 0) return "now";
  const totalMinutes = Math.floor(secondsUntil / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    const minutes = totalMinutes % 60;
    return `${totalHours}h${String(minutes).padStart(2, "0")}m`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d${hours}h`;
}
