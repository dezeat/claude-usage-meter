import { homedir } from "node:os";
import { join } from "node:path";

import { updateIndex } from "./index-store.js";
import { resolveLocation } from "./location.js";
import { parsePayload } from "./payload.js";
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
// unrecognized value degrades to the product default (line + bar); the pure
// renderer never sees an env var. The product default layout is `line`.
function layoutMode(): "block" | "line" {
  return process.env.USAGE_METER_LAYOUT === "block" ? "block" : "line";
}

function meterMode(): "bar" | "pill" {
  return process.env.USAGE_METER_METERS === "pill" ? "pill" : "bar";
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
      observedAt: Date.now(),
    },
    // The session this statusline belongs to: folded every tick even when the
    // cross-project sweep is debounced, so its own usage never freezes (#63, H1).
    parsed.transcriptPath,
  ).catch(() => null);
  const line = renderLine(parsed, new Date(), {
    color: colorEnabled(),
    index,
    indexPath: INDEX_PATH,
    location: resolveLocation(parsed.cwd),
    limits: index?.limits,
    layout: layoutMode(),
    meters: meterMode(),
    columns: terminalColumns(),
  });
  process.stdout.write(`${line}\n`);
}

// A statusline must never crash the bar: on any failure, still emit a line.
void main().catch(() => {
  process.stdout.write(`${PLACEHOLDER_LINE}\n`);
});
