import { homedir } from "node:os";
import { join } from "node:path";

import { modelClass, updateIndex } from "./index-store.js";
import {
  heartbeatLivenessWindowMs,
  parseRefreshIntervalMs,
} from "./fleet-render.js";
import { resolveLocation } from "./location.js";
import { parsePayload, type ParsedPayload } from "./payload.js";
import { DEFAULT_PRICING } from "./pricing.js";
import { PLACEHOLDER_LINE, renderLine } from "./render.js";
import { readStdin } from "./stdin.js";

const INDEX_PATH = join(homedir(), ".claude", "usage-meter", "index.db");
const CLAUDE_DIR = join(homedir(), ".claude", "projects");

// NO_COLOR convention: any non-empty value disables ANSI colour.
function colorEnabled(): boolean {
  const flag = process.env.NO_COLOR;
  return flag === undefined || flag === "";
}

// ADR-0007 presentation toggles, read at the edge exactly like NO_COLOR. An
// unrecognized value degrades to the product default (block + bar); the pure
// renderer never sees an env var. The product default layout is `block` (the
// four stacked rows); `line` is the opt-in single-line HUD.
function layoutMode(): "block" | "line" {
  return process.env.USAGE_METER_LAYOUT === "line" ? "line" : "block";
}

function meterMode(): "bar" | "pill" {
  return process.env.USAGE_METER_METERS === "pill" ? "pill" : "bar";
}

// The active session's model class off its payload, stamped onto its heartbeat row
// so a just-opened session names itself in every other session's live roster
// instead of "unknown" (it has no folded transcript yet). Mirrors render's
// activeClass; an unusable model degrades to undefined (left NULL, never a sticky
// "unknown"), matching modelClass's own miss sentinel.
function activeModelClass(payload: ParsedPayload): string | undefined {
  const id = payload.modelId ?? payload.modelName?.toLowerCase();
  if (id === undefined) return undefined;
  const cls = modelClass(id);
  return cls === "unknown" ? undefined : cls;
}

// Terminal width for the never-wrap HUD. Claude Code sets COLUMNS; an absent,
// non-numeric, or non-positive value falls back to 80.
function terminalColumns(): number {
  const parsed = Number.parseInt(process.env.COLUMNS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 80;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const payload: unknown = JSON.parse(raw);
  const parsed = parsePayload(payload);
  const tickNow = new Date();
  // This session's 5h/7d snapshot, stamped with the edge wall clock, so the shared
  // store learns the freshest account-wide windows (Discussion #63, Part 1). The
  // resolved freshest comes back on index.limits and renderLine prefers it over the
  // local payload, degrading to the payload when the store is empty/unavailable.
  const index = await updateIndex(
    INDEX_PATH,
    CLAUDE_DIR,
    DEFAULT_PRICING,
    {
      fiveHour: parsed.fiveHour,
      sevenDay: parsed.sevenDay,
      observedAt: tickNow.getTime(),
    },
    // The session this statusline belongs to: folded every tick even when the
    // cross-project sweep is debounced, so its own usage never freezes (#63, H1).
    parsed.transcriptPath,
    tickNow.getTime(),
    activeModelClass(parsed),
  ).catch(() => null);
  const line = renderLine(parsed, tickNow, {
    color: colorEnabled(),
    index,
    indexPath: INDEX_PATH,
    location: resolveLocation(parsed.cwd),
    limits: index?.limits,
    layout: layoutMode(),
    meters: meterMode(),
    columns: terminalColumns(),
    livenessWindowMs: heartbeatLivenessWindowMs(
      parseRefreshIntervalMs(process.env.USAGE_METER_REFRESH_INTERVAL),
    ),
  });
  process.stdout.write(`${line}\n`);
}

// A statusline must never crash the bar: on any failure, still emit a line.
void main().catch(() => {
  process.stdout.write(`${PLACEHOLDER_LINE}\n`);
});
