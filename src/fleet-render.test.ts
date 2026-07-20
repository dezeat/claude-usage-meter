import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  LIVENESS_WINDOW_MS,
  heartbeatLivenessWindowMs,
  parseRefreshIntervalMs,
  fleetLineSegments,
  liveClassCounts,
  monthClassCounts,
  renderFleet,
  renderMonthly,
  renderRoster,
} from "./fleet-render.js";
import {
  updateIndex,
  type CrossSessionIndex,
  type ModelUsage,
} from "./index-store.js";
import { parsePayload } from "./payload.js";
import { renderLine } from "./render.js";
import { DEFAULT_PRICING } from "./pricing.js";

// SGR codes asserted via ESC-escaped string includes — never a regex with the
// ESC byte, which trips the no-control-regex lint.
const ESC = String.fromCharCode(27);
const DIM = `${ESC}[2m`;
const BRIGHT = `${ESC}[97m`;
const GREEN = `${ESC}[32m`;

const NOW_MS = 1_000_000_000_000;

// A throwaway db path with no rows: renderMonthly reads zeros from it, which is
// all the roster/spend tests below need (they assert nothing about the monthly
// segment). Monthly-spend behaviour is exercised against a populated db further
// down.
const EMPTY_INDEX_PATH = ":memory:";

// Build a real SQLite store from synthetic transcripts so renderMonthly's SQL
// month/class rollup runs against actual rows. Returns the db path for the
// renderer to query.
async function buildSpendDb(
  sessions: Array<{ model: string; ts: string; input: number; output: number }>,
): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "fleet-spend-test-"));
  const projectDir = join(tmp, "projects", "-fake-midnight-marble");
  mkdirSync(projectDir, { recursive: true });
  sessions.forEach((s, i) => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: s.ts,
      gitBranch: "main",
      requestId: `r${i}`,
      message: {
        id: `m${i}`,
        model: s.model,
        usage: { input_tokens: s.input, output_tokens: s.output },
      },
    });
    writeFileSync(join(projectDir, `s${i}.jsonl`), line + "\n", "utf8");
  });
  const dbPath = join(tmp, "index.db");
  await updateIndex(dbPath, join(tmp, "projects"), DEFAULT_PRICING);
  return dbPath;
}

function makeIndex(
  sessions: Array<{
    modelClass: string;
    lastTs: number;
    costUsd: number;
    parentSessionId?: string;
    heartbeatMs?: number;
  }>,
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
      parentSessionId: s.parentSessionId,
      heartbeatMs: s.heartbeatMs,
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

const FLEET_MONTH = new Date(NOW_MS).toISOString().slice(0, 7);

test("an all-idle fleet renders the count cell as <monthCount> Σ <monthTotal> with no roster cell", () => {
  const cells = renderRoster(FLEET_INDEX, "opus", FLEET_MONTH, NOW_MS, false);
  assert.deepStrictEqual(cells, ["2 Σ 4"]);
});

test("the count cell joins the active-class month count and the month total with a Σ connective, never a slash", () => {
  const cells = renderRoster(FLEET_INDEX, "opus", FLEET_MONTH, NOW_MS, false);
  assert.strictEqual(cells[0], "2 Σ 4");
  assert.ok(!cells[0]?.includes("mdl"), "the mdl self-tag is dropped");
  assert.ok(!cells[0]?.includes("mo"), "the mo qualifier is dropped");
  assert.ok(!cells[0]?.includes("/"), "the cell uses ' Σ ', never a slash");
  assert.ok(!cells[0]?.includes("·"), "the cell uses Σ, not a middle dot");
});

test("with colour the count cell dims the Σ connective like the spend row while the counts stay bright", () => {
  const [countCell] = renderRoster(
    FLEET_INDEX,
    "opus",
    FLEET_MONTH,
    NOW_MS,
    true,
  );
  assert.ok(countCell !== undefined);
  assert.ok(!countCell.includes("mdl"), "no self-tag on the count cell");
  assert.ok(
    countCell.includes(`${DIM}Σ`),
    "the Σ connective is dim, matching the spend-row Σ",
  );
  assert.ok(
    countCell.includes(`${BRIGHT}2`),
    "the active-class month count is bright",
  );
  assert.ok(countCell.includes(`${BRIGHT}4`), "the month total is bright");
});

test("the monthly spend cells are cost-forward with Σ, no % and no bar glyphs", () => {
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  const { spendCells } = renderFleet(
    FLEET_INDEX,
    EMPTY_INDEX_PATH,
    "opus",
    2.14,
    undefined,
    month,
    NOW_MS,
    false,
  );
  const spend = spendCells.join(" ");
  assert.match(spend, /Σ \$/);
  assert.ok(!spend.includes("%"), "spend row must not contain %");
  assert.ok(
    !spend.includes("▓") && !spend.includes("░"),
    "spend row must not contain bar characters",
  );
});

test("the spend and fleet cells emit no green-on-bar, yellow, or red SGR codes", () => {
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  const { spendCells, fleetCells } = renderFleet(
    FLEET_INDEX,
    EMPTY_INDEX_PATH,
    "opus",
    2.14,
    undefined,
    month,
    NOW_MS,
    true,
  );
  // spend cells carry no class colour at all; fleet may carry green only on the
  // live ● glyph — assert no yellow/red anywhere, and no green in spend.
  for (const out of spendCells) {
    assert.ok(!out.includes(GREEN), "no green SGR in spend cells");
  }
  for (const out of [...spendCells, ...fleetCells]) {
    assert.ok(!out.includes(`${ESC}[33m`), "no yellow SGR in fleet/spend");
    assert.ok(!out.includes(`${ESC}[31m`), "no red SGR in fleet/spend");
  }
});

test("a null index omits the fleet row, rendering the current, limits and a cost spend row", () => {
  const payload = parsePayload({
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    cost: { total_cost_usd: 3.45 },
    context_window: { used_percentage: 24 },
  });
  const now = new Date(NOW_MS);
  const withNullIndex = renderLine(payload, now, { color: false, index: null });
  const rows = withNullIndex.split("\n");
  // The current row leads (model "opus 4.8"); limits follows it.
  assert.match(rows[0] ?? "", /^current {2}opus 4\.8$/);
  assert.match(rows[1] ?? "", /^limits .*ctx .* 24%/);
  assert.ok(
    !withNullIndex.includes("\nfleet"),
    "no fleet row with a null index",
  );
  assert.ok(!withNullIndex.includes("Σ"), "no Σ total with a null index");
});

function makeIndexWithSession(
  sessionId: string,
  path: string,
  tokens: Record<string, ModelUsage>,
  costUsd: number,
): CrossSessionIndex {
  return {
    sessions: {
      [sessionId]: {
        path,
        sessionId,
        branch: "main",
        modelClass: "opus",
        tokens,
        costUsd,
        lastTs: NOW_MS,
        byteOffset: 0,
      },
    },
    byMonth: {
      [new Date(NOW_MS).toISOString().slice(0, 7)]: { tokens: {}, costUsd },
    },
    byBranch: {},
    updatedAt: NOW_MS,
  };
}

test("the spend cells lead with the live ses cost and burn, then the session's cache% cell", () => {
  const index = makeIndexWithSession(
    "abc",
    "/t/abc.jsonl",
    {
      "claude-opus-4-8": {
        inputTokens: 500_000,
        outputTokens: 500_000,
        cacheReadTokens: 100_000,
        cacheCreationTokens: 100_000,
      },
    },
    2.14,
  );
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  // A 1-hour duration makes the burn the cost itself: $2.14/(3.6e6/3.6e6) = $2.14/hr.
  const { spendCells } = renderFleet(
    index,
    EMPTY_INDEX_PATH,
    "opus",
    2.14,
    3_600_000,
    month,
    NOW_MS,
    false,
    { sessionId: "abc" },
  );
  assert.strictEqual(spendCells[0], "ses $2.14 ↑$2.14/hr");
  // 100k cache reads of 1.2M total tokens → an 8% cache signal.
  assert.strictEqual(spendCells[1], "8% cached");
  assert.ok(
    !spendCells[0]?.includes("i:"),
    "no raw token trail on the ses cell",
  );
});

test("when the session is not in the store the spend cell falls back to cost only, no cache cell", () => {
  const index = makeIndexWithSession("abc", "/t/abc.jsonl", {}, 2.14);
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  const { spendCells } = renderFleet(
    index,
    EMPTY_INDEX_PATH,
    "opus",
    1.07,
    undefined,
    month,
    NOW_MS,
    false,
    { sessionId: "not-indexed-yet" },
  );
  assert.strictEqual(spendCells[0], "ses $1.07");
  assert.ok(
    !spendCells.some((c) => c.includes("cached")),
    "no cache cell without session tokens",
  );
  assert.ok(
    !spendCells[0]?.includes(" 0"),
    "must not print a 0-token spend cell",
  );
});

// Month-scope + liveness behaviour. A fixed now sits inside June 2026; the
// session set straddles May and June so prior-month rows must be excluded from
// the counts. Liveness is asserted against the same fixed now.
const JUN_NOW_MS = Date.UTC(2026, 5, 15, 12, 0, 0);
const JUN_MONTH = "2026-06";
const MAY_TS = Date.UTC(2026, 4, 20, 10, 0, 0);
const JUN_IDLE_TS = JUN_NOW_MS - 10 * 60 * 1000;
const JUN_LIVE_TS = JUN_NOW_MS - 10 * 1000;

const TWO_MONTH_INDEX = makeIndex(
  [
    { modelClass: "opus", lastTs: JUN_LIVE_TS, costUsd: 1.0 },
    { modelClass: "opus", lastTs: JUN_IDLE_TS, costUsd: 1.0 },
    { modelClass: "sonnet", lastTs: JUN_LIVE_TS, costUsd: 1.0 },
    { modelClass: "opus", lastTs: MAY_TS, costUsd: 1.0 },
    { modelClass: "sonnet", lastTs: MAY_TS, costUsd: 1.0 },
    { modelClass: "haiku", lastTs: MAY_TS, costUsd: 1.0 },
  ],
  0,
);

test("month counts include only current-month sessions and exclude the prior month", () => {
  const counts = monthClassCounts(TWO_MONTH_INDEX.sessions, JUN_MONTH);
  const byClass = new Map(counts.map((c) => [c.cls, c.count]));
  assert.strictEqual(
    byClass.get("opus"),
    2,
    "2 June opus, 1 May opus excluded",
  );
  assert.strictEqual(
    byClass.get("sonnet"),
    1,
    "1 June sonnet, 1 May sonnet excluded",
  );
  assert.strictEqual(
    byClass.get("haiku"),
    undefined,
    "haiku only ran in May — absent from June counts",
  );
  const total = counts.reduce((s, c) => s + c.count, 0);
  assert.strictEqual(total, 3, "month total counts only June's 3 sessions");
});

test("the HUD roster abbreviates each live class to its initial with a parenthesised count", () => {
  const idx = makeIndex(
    [
      { modelClass: "opus", lastTs: NOW_MS, costUsd: 1 },
      { modelClass: "sonnet", lastTs: NOW_MS, costUsd: 1 },
    ],
    0,
  );
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  const { fleet } = fleetLineSegments(
    idx,
    EMPTY_INDEX_PATH,
    "opus",
    undefined,
    undefined,
    month,
    NOW_MS,
    false,
  );
  const roster = fleet[fleet.length - 1]?.text ?? "";
  assert.strictEqual(roster, "●o(1) ●s(1)");
  assert.ok(
    !roster.includes("opus") && !roster.includes("sonnet"),
    "the HUD roster spells no class name in full",
  );
});

test("the fleet count and live tally exclude subagent records — a subagent is not a session", () => {
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  const idx = makeIndex(
    [
      { modelClass: "opus", lastTs: NOW_MS, costUsd: 1 },
      // A live haiku subagent under the opus parent: real spend, not a session.
      {
        modelClass: "haiku",
        lastTs: NOW_MS,
        costUsd: 1,
        parentSessionId: "session-0",
      },
    ],
    0,
  );

  assert.deepStrictEqual(monthClassCounts(idx.sessions, month), [
    { cls: "opus", count: 1 },
  ]);
  assert.deepStrictEqual(liveClassCounts(idx.sessions, NOW_MS), [
    { cls: "opus", count: 1 },
  ]);
});

test("the count cell is the active-class month count Σ month total, plus an active cell per live class", () => {
  const cells = renderRoster(
    TWO_MONTH_INDEX,
    "opus",
    JUN_MONTH,
    JUN_NOW_MS,
    false,
  );
  assert.deepStrictEqual(cells, ["2 Σ 3", "● opus 1 ● sonnet 1"]);
});

test("a fresh single-session fixture renders the month count, never an all-time total", () => {
  const single = makeIndex(
    [{ modelClass: "opus", lastTs: JUN_IDLE_TS, costUsd: 1.0 }],
    0,
  );
  const cells = renderRoster(single, "opus", JUN_MONTH, JUN_NOW_MS, false);
  assert.deepStrictEqual(cells, ["1 Σ 1"]);

  const priorMonthOnly = makeIndex(
    [{ modelClass: "opus", lastTs: MAY_TS, costUsd: 1.0 }],
    0,
  );
  const emptyCells = renderRoster(
    priorMonthOnly,
    "opus",
    JUN_MONTH,
    JUN_NOW_MS,
    false,
  );
  assert.deepStrictEqual(
    emptyCells,
    ["0 Σ 0"],
    "a session only in a prior month leaves the current month empty",
  );
});

test("the live active tally self-excludes the current session", () => {
  // Two live opus, one of them the current session → renders opus 1.
  const twoLiveOpus = makeIndex(
    [
      { modelClass: "opus", lastTs: JUN_LIVE_TS, costUsd: 1.0 },
      { modelClass: "opus", lastTs: JUN_LIVE_TS, costUsd: 1.0 },
    ],
    0,
  );
  const cells = renderRoster(
    twoLiveOpus,
    "opus",
    JUN_MONTH,
    JUN_NOW_MS,
    false,
    "session-0",
  );
  assert.deepStrictEqual(cells, ["2 Σ 2", "● opus 1"]);
});

test("the active cell is dropped when the current session is the only live one", () => {
  const oneLiveOpus = makeIndex(
    [{ modelClass: "opus", lastTs: JUN_LIVE_TS, costUsd: 1.0 }],
    0,
  );
  const cells = renderRoster(
    oneLiveOpus,
    "opus",
    JUN_MONTH,
    JUN_NOW_MS,
    false,
    "session-0",
  );
  assert.deepStrictEqual(cells, ["1 Σ 1"]);
});

test("live count includes only sessions within the liveness window, grouped per class", () => {
  const live = liveClassCounts(TWO_MONTH_INDEX.sessions, JUN_NOW_MS);
  const byClass = new Map(live.map((c) => [c.cls, c.count]));
  assert.strictEqual(
    byClass.get("opus"),
    1,
    "one opus is live, the idle excluded",
  );
  assert.strictEqual(byClass.get("sonnet"), 1, "one sonnet is live");
  assert.strictEqual(
    byClass.get("haiku"),
    undefined,
    "May haiku is far outside the window",
  );
});

test("heartbeat liveness uses three refresh ticks and rejects invalid intervals", () => {
  assert.strictEqual(heartbeatLivenessWindowMs(10_000), 30_000);
  assert.strictEqual(heartbeatLivenessWindowMs(60_000), 180_000);
  assert.strictEqual(heartbeatLivenessWindowMs(0), LIVENESS_WINDOW_MS);
  assert.strictEqual(heartbeatLivenessWindowMs(Number.NaN), LIVENESS_WINDOW_MS);
});

test("refresh interval environment values parse as seconds with a safe default", () => {
  assert.strictEqual(parseRefreshIntervalMs("60"), 60_000);
  assert.strictEqual(parseRefreshIntervalMs("1"), 1_000);
  assert.strictEqual(parseRefreshIntervalMs(undefined), 10_000);
  assert.strictEqual(parseRefreshIntervalMs("invalid"), 10_000);
  assert.strictEqual(parseRefreshIntervalMs("0"), 10_000);
});

test("pure liveness prefers heartbeat, falls back to lastTs, and uses a strict expiry boundary", () => {
  const windowMs = 30_000;
  const index = makeIndex(
    [
      { modelClass: "opus", lastTs: NOW_MS - 1, costUsd: 0 },
      {
        modelClass: "sonnet",
        lastTs: NOW_MS - 1,
        heartbeatMs: NOW_MS - windowMs,
        costUsd: 0,
      },
      {
        modelClass: "haiku",
        lastTs: NOW_MS - 60_000,
        heartbeatMs: NOW_MS - windowMs + 1,
        costUsd: 0,
      },
    ],
    0,
  );

  assert.deepStrictEqual(
    liveClassCounts(index.sessions, NOW_MS, undefined, windowMs),
    [
      { cls: "haiku", count: 1 },
      { cls: "opus", count: 1 },
    ],
  );
});

test("block and HUD self-exclude by transcript when session_id is absent or disagrees", () => {
  const index = makeIndex(
    [
      { modelClass: "opus", lastTs: NOW_MS, costUsd: 0 },
      { modelClass: "sonnet", lastTs: NOW_MS, costUsd: 0 },
    ],
    0,
  );
  const month = new Date(NOW_MS).toISOString().slice(0, 7);

  for (const session of [
    { transcriptPath: "/fake/session-0.jsonl" },
    {
      sessionId: "session-1",
      transcriptPath: "/fake/session-0.jsonl",
    },
  ]) {
    const block = renderFleet(
      index,
      EMPTY_INDEX_PATH,
      "opus",
      undefined,
      undefined,
      month,
      NOW_MS,
      false,
      session,
    );
    assert.deepStrictEqual(block.fleetCells, ["1 Σ 2", "● sonnet 1"]);

    const hud = fleetLineSegments(
      index,
      EMPTY_INDEX_PATH,
      "opus",
      undefined,
      undefined,
      month,
      NOW_MS,
      false,
      session,
    );
    assert.deepStrictEqual(
      hud.fleet.map((segment) => segment.text),
      ["1 Σ 2", "●s(1)"],
    );
  }
});

test("block and HUD both honor the refresh-derived liveness window", () => {
  const index = makeIndex(
    [{ modelClass: "opus", lastTs: NOW_MS - 60_000, costUsd: 0 }],
    0,
  );
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  const windowMs = heartbeatLivenessWindowMs(parseRefreshIntervalMs("60"));

  const block = renderFleet(
    index,
    EMPTY_INDEX_PATH,
    "sonnet",
    undefined,
    undefined,
    month,
    NOW_MS,
    false,
    {},
    windowMs,
  );
  assert.deepStrictEqual(block.fleetCells, ["0 Σ 1", "● opus 1"]);

  const hud = fleetLineSegments(
    index,
    EMPTY_INDEX_PATH,
    "sonnet",
    undefined,
    undefined,
    month,
    NOW_MS,
    false,
    {},
    windowMs,
  );
  assert.deepStrictEqual(
    hud.fleet.map((segment) => segment.text),
    ["0 Σ 1", "●o(1)"],
  );
});

test("liveClassCounts excludes the named session id", () => {
  const live = liveClassCounts(
    TWO_MONTH_INDEX.sessions,
    JUN_NOW_MS,
    "session-0",
  );
  const byClass = new Map(live.map((c) => [c.cls, c.count]));
  assert.strictEqual(
    byClass.get("opus"),
    undefined,
    "the only live opus is the excluded current session",
  );
  assert.strictEqual(byClass.get("sonnet"), 1, "sonnet is untouched");
});

test("live counts are independent of month scope across a month rollover", () => {
  // now is five seconds into July; a session whose last_ts is five seconds before
  // the rollover is still inside the liveness window though it belongs to June.
  const rolloverNow = Date.UTC(2026, 6, 1, 0, 0, 5);
  const juneEdgeTs = Date.UTC(2026, 5, 30, 23, 59, 55);
  assert.ok(
    rolloverNow - juneEdgeTs < LIVENESS_WINDOW_MS,
    "fixture sits inside the liveness window",
  );
  const index = makeIndex(
    [{ modelClass: "opus", lastTs: juneEdgeTs, costUsd: 1.0 }],
    0,
  );

  const live = liveClassCounts(index.sessions, rolloverNow);
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0]?.cls, "opus");
  assert.strictEqual(
    live[0]?.count,
    1,
    "edge-of-June session still counts live",
  );

  const juneCounts = monthClassCounts(index.sessions, "2026-06");
  assert.strictEqual(
    juneCounts.find((c) => c.cls === "opus")?.count,
    1,
    "the same session is counted in June's month total",
  );
  const julyCounts = monthClassCounts(index.sessions, "2026-07");
  assert.strictEqual(
    julyCounts.length,
    0,
    "it is not counted in July even though it is live now",
  );
});

// Monthly-spend rollup (T04). A June store with one opus session (1.0M input →
// $5.00) and one sonnet session (2.0M input → $6.00) gives an opus class slice
// of 1.0M/$5.00 and a Σ of 3.0M/$11.00 spanning both classes.
const SPEND_MONTH = "2026-06";
const SPEND_SESSIONS = [
  {
    model: "claude-opus-4-8",
    ts: "2026-06-10T10:00:00.000Z",
    input: 1_000_000,
    output: 0,
  },
  {
    model: "claude-sonnet-4-6",
    ts: "2026-06-11T10:00:00.000Z",
    input: 2_000_000,
    output: 0,
  },
];

test("renderMonthly returns only the dim Σ month total — no per-class mdl cell, no token trail", async () => {
  const dbPath = await buildSpendDb(SPEND_SESSIONS);
  const cell = renderMonthly(dbPath, SPEND_MONTH, false);
  assert.strictEqual(cell, "Σ $11.00 mo");
  assert.ok(!cell.includes("mdl"), "the per-class mdl cost cell is dropped");
  assert.ok(!cell.includes("i:"), "the token trail is dropped from the ledger");
});

test("the Σ month total sums every class and carries no percentage", async () => {
  const dbPath = await buildSpendDb(SPEND_SESSIONS);
  const cell = renderMonthly(dbPath, SPEND_MONTH, false);
  assert.strictEqual(cell, "Σ $11.00 mo", "$5.00 opus + $6.00 sonnet");
  assert.ok(!cell.includes("%"), "no percentage on the ledger cell");
});

test("a month with no indexed sessions renders a dim Σ $0.00 mo ledger", async () => {
  const dbPath = await buildSpendDb(SPEND_SESSIONS);
  const cell = renderMonthly(dbPath, "2026-01", false);
  assert.strictEqual(cell, "Σ $0.00 mo");
});

test("the whole Σ ledger cell is dim so the accumulated total recedes below the live figures", async () => {
  const dbPath = await buildSpendDb(SPEND_SESSIONS);
  const cell = renderMonthly(dbPath, SPEND_MONTH, true);
  assert.strictEqual(cell, `${DIM}Σ $11.00 mo${ESC}[0m`);
});
