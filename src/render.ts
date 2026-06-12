import { paint } from "./ansi.js";
import {
  FIVE_HOUR_SECONDS,
  SEVEN_DAY_SECONDS,
  contextBar,
  elapsedFraction,
  formatCountdown,
  paceBar,
} from "./bars.js";
import { type ParsedPayload, type RateWindow } from "./payload.js";

export const PLACEHOLDER_LINE = "usage-meter · waiting for data";

const SEPARATOR = "  ";

interface RenderOptions {
  color?: boolean;
}

function renderLimit(
  label: string,
  window: RateWindow,
  windowSeconds: number,
  now: Date,
  color: boolean,
): string {
  const fraction = elapsedFraction(window.resetsAt, windowSeconds, now);
  const bar = paceBar(window.usedPercentage, fraction, color);
  const percentage = `${Math.round(window.usedPercentage)}%`;
  const remainingSeconds = window.resetsAt - now.getTime() / 1000;
  const reset = paint(`⟳${formatCountdown(remainingSeconds)}`, "dim", color);
  return `${label} ${bar} ${percentage} ${reset}`;
}

export function renderLine(
  payload: ParsedPayload,
  now: Date,
  options: RenderOptions = {},
): string {
  const color = options.color ?? true;
  const segments: string[] = [];

  segments.push(paint(payload.modelName ?? "Claude", "dim", color));

  if (payload.contextPercentage !== undefined) {
    const bar = contextBar(payload.contextPercentage, color);
    segments.push(`ctx ${bar} ${Math.round(payload.contextPercentage)}%`);
  }

  if (payload.fiveHour) {
    segments.push(
      renderLimit("5h", payload.fiveHour, FIVE_HOUR_SECONDS, now, color),
    );
  }
  if (payload.sevenDay) {
    segments.push(
      renderLimit("7d", payload.sevenDay, SEVEN_DAY_SECONDS, now, color),
    );
  }

  if (payload.costUsd !== undefined) {
    segments.push(paint(`$${payload.costUsd.toFixed(2)}`, "dim", color));
  }

  return segments.join(SEPARATOR);
}
