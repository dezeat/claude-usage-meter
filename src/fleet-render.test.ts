import { test } from "node:test";
import assert from "node:assert/strict";

import { renderFleet, renderRoster } from "./fleet-render.js";
import { type CrossSessionIndex } from "./index-store.js";
import { parsePayload } from "./payload.js";
import { renderLine } from "./render.js";

const NOW_MS = 1_000_000_000_000;

function makeIndex(
  sessions: Array<{ modelClass: string; lastTs: number; costUsd: number }>,
  monthCostUsd: number,
): CrossSessionIndex {
  const sessionsRecord: CrossSessionIndex["sessions"] = {};
  for (const [i, s] of sessions.entries()) {
    const path = `/fake/session-${i}.jsonl`;
    sessionsRecord[path] = {
      path,
      sessionId: `session-${i}`,
      branch: "main",
      modelClass: s.modelClass,
      tokens: {},
      costUsd: s.costUsd,
      lastTs: s.lastTs,
      byteOffset: 0,
    };
  }
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  return {
    sessions: sessionsRecord,
    byMonth: { [month]: { tokens: {}, costUsd: monthCostUsd } },
    byBranch: {},
    updatedAt: NOW_MS,
  };
}

const IDLE_TS = NOW_MS - 10 * 60 * 1000;

const FLEET_INDEX = makeIndex(
  [
    { modelClass: "opus", lastTs: IDLE_TS, costUsd: 1.0 },
    { modelClass: "opus", lastTs: IDLE_TS, costUsd: 1.14 },
    { modelClass: "fable", lastTs: IDLE_TS, costUsd: 5.0 },
    { modelClass: "sonnet", lastTs: IDLE_TS, costUsd: 2.0 },
  ],
  58.03,
);

test("2 opus + 1 fable + 1 sonnet yields roster ⎇ 2/4 opus · 1 fable · 1 sonnet", () => {
  const roster = renderRoster(FLEET_INDEX, "opus", NOW_MS, false);
  assert.strictEqual(roster, "⎇ 2/4 opus · 1 fable · 1 sonnet");
});

test("monthly segment renders as mo $<amount> with no % and no bar", () => {
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  const output = renderFleet(FLEET_INDEX, "opus", 2.14, month, NOW_MS, false);
  assert.match(output, /mo \$/);
  assert.ok(!output.includes("%"), "monthly segment must not contain %");
  assert.ok(
    !output.includes("▓") && !output.includes("░"),
    "monthly segment must not contain bar characters",
  );
});

test("no ambiguous-width glyph is flush against text", () => {
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  const output = renderFleet(FLEET_INDEX, "opus", 2.14, month, NOW_MS, false);
  assert.ok(!output.includes("⎇2"), "⎇ must not be flush against a digit");
  assert.ok(!output.includes("·1"), "· must not be flush against a digit");
  assert.ok(
    !output.includes("2/4opus"),
    "count must be separated from class name",
  );
});

test("new fleet segments emit no green, yellow, or red SGR codes", () => {
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  const output = renderFleet(FLEET_INDEX, "opus", 2.14, month, NOW_MS, true);
  assert.ok(!output.includes("\x1b[32m"), "no green SGR in fleet segment");
  assert.ok(!output.includes("\x1b[33m"), "no yellow SGR in fleet segment");
  assert.ok(!output.includes("\x1b[31m"), "no red SGR in fleet segment");
});

test("with no index the rendered line equals the pre-ticket output", () => {
  const payload = parsePayload({
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    cost: { total_cost_usd: 3.45 },
    context_window: { used_percentage: 24 },
  });
  const now = new Date(NOW_MS);
  const withoutFleet = renderLine(payload, now, { color: false });
  const withNullIndex = renderLine(payload, now, { color: false, index: null });
  assert.strictEqual(
    withNullIndex,
    withoutFleet,
    "null index must produce identical output to no-index call",
  );
});
