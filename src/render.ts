import { paint, padVisible } from "./ansi.js";
import {
  FIVE_HOUR_SECONDS,
  SEVEN_DAY_SECONDS,
  contextBar,
  elapsedFraction,
  formatCountdown,
  paceBar,
} from "./bars.js";
import { renderFleet } from "./fleet-render.js";
import { type CrossSessionIndex, modelClass } from "./index-store.js";
import { type ParsedPayload, type RateWindow } from "./payload.js";

export const PLACEHOLDER_LINE = "usage-meter · waiting for data";

const LIMIT_GAP = "   ";
const ROW_LABELS = ["limits", "spend", "fleet"] as const;
const GUTTER = Math.max(...ROW_LABELS.map((l) => l.length));

interface RenderOptions {
  color?: boolean;
  index?: CrossSessionIndex | null;
  indexPath?: string;
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

function limitsRow(payload: ParsedPayload, now: Date, color: boolean): string {
  const cells: string[] = [];

  if (payload.contextPercentage !== undefined) {
    const bar = contextBar(payload.contextPercentage, color);
    cells.push(`ctx ${bar} ${Math.round(payload.contextPercentage)}%`);
  }
  if (payload.fiveHour) {
    cells.push(
      renderLimit("5h", payload.fiveHour, FIVE_HOUR_SECONDS, now, color),
    );
  }
  if (payload.sevenDay) {
    cells.push(
      renderLimit("7d", payload.sevenDay, SEVEN_DAY_SECONDS, now, color),
    );
  }

  return cells.join(LIMIT_GAP);
}

// The active model class drives the spend/fleet scoping; derive it from the
// payload's model id, falling back to the display name. modelClass normalises
// either form to the stored class key ("opus" etc.) — passing the raw display
// name ("Opus 4.8") straight through would never match the stored "opus" key.
function activeClass(payload: ParsedPayload): string {
  if (payload.modelId) return modelClass(payload.modelId);
  if (payload.modelName) return modelClass(payload.modelName.toLowerCase());
  return "unknown";
}

function labelled(label: string, content: string, color: boolean): string {
  return `${paint(padVisible(label, GUTTER), "dim", color)} ${content}`;
}

export function renderLine(
  payload: ParsedPayload,
  now: Date,
  options: RenderOptions = {},
): string {
  const color = options.color ?? true;

  const rows: string[] = [];

  const limits = limitsRow(payload, now, color);
  if (limits !== "") rows.push(labelled("limits", limits, color));

  const index = options.index ?? null;
  if (index !== null) {
    const month = now.toISOString().slice(0, 7);
    const { spend, fleet } = renderFleet(
      index,
      options.indexPath ?? "",
      activeClass(payload),
      payload.costUsd,
      month,
      now.getTime(),
      color,
      { sessionId: payload.sessionId, transcriptPath: payload.transcriptPath },
    );
    if (spend !== "") rows.push(labelled("spend", spend, color));
    if (fleet !== "") rows.push(labelled("fleet", fleet, color));
  } else if (payload.costUsd !== undefined) {
    const ses = paint(
      `ses $${payload.costUsd.toFixed(2)}`,
      "brightWhite",
      color,
    );
    rows.push(labelled("spend", ses, color));
  }

  if (rows.length === 0) {
    return labelled(
      "limits",
      paint(payload.modelName ?? "Claude", "dim", color),
      color,
    );
  }

  return rows.join("\n");
}
