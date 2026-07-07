import { fillColor } from "./bars.js";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Severity is the single flat-% rule from bars.ts (green ≤ 50, yellow ≤ 70, red
// > 70); the pill only maps that ColorName to its reverse-video background so the
// ramp stays in one place.
const PILL_BACKGROUND = {
  green: "\x1b[42m",
  yellow: "\x1b[43m",
  red: "\x1b[41m",
} as const;

// A compact reverse-video badge — black text on a severity-coloured background.
// Under NO_COLOR the ramp is the only signal, so it degrades to bracketed text
// [NN%]: the value and badge shape survive, the colour carries no meaning to lose.
export function limitPill(usedPercentage: number, color: boolean): string {
  const pct = clamp(Math.round(usedPercentage), 0, 100);
  if (!color) return `[${pct}%]`;
  const bg = PILL_BACKGROUND[fillColor(pct)];
  return `${bg}\x1b[30m ${pct}% \x1b[0m`;
}
