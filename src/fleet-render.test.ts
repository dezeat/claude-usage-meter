import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  LIVENESS_WINDOW_MS,
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

const FLEET_MONTH = new Date(NOW_MS).toISOString().slice(0, 7);

test("an all-idle fleet renders the active class count·total with no live segment", () => {
  const roster = renderRoster(FLEET_INDEX, "opus", FLEET_MONTH, NOW_MS, false);
  assert.strictEqual(roster, "opus 2·4 mo");
});

test("the monthly spend cells carry Σ with no % and no bar glyphs", () => {
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  const { spend } = renderFleet(
    FLEET_INDEX,
    EMPTY_INDEX_PATH,
    "opus",
    2.14,
    month,
    NOW_MS,
    false,
  );
  assert.match(spend, /Σ /);
  assert.ok(!spend.includes("%"), "spend row must not contain %");
  assert.ok(
    !spend.includes("▓") && !spend.includes("░"),
    "spend row must not contain bar characters",
  );
});

test("the fleet row separates the count head, total and class name from glyphs", () => {
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  const { fleet } = renderFleet(
    FLEET_INDEX,
    EMPTY_INDEX_PATH,
    "opus",
    2.14,
    month,
    NOW_MS,
    false,
  );
  assert.match(fleet, /opus 2·4 mo/);
});

test("the spend and fleet rows emit no green, yellow, or red SGR codes", () => {
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  const { spend, fleet } = renderFleet(
    FLEET_INDEX,
    EMPTY_INDEX_PATH,
    "opus",
    2.14,
    month,
    NOW_MS,
    true,
  );
  for (const out of [spend, fleet]) {
    assert.ok(!out.includes("\x1b[32m"), "no green SGR in fleet/spend segment");
    assert.ok(
      !out.includes("\x1b[33m"),
      "no yellow SGR in fleet/spend segment",
    );
    assert.ok(!out.includes("\x1b[31m"), "no red SGR in fleet/spend segment");
  }
});

test("a null index omits the fleet row and renders only limits and a cost spend row", () => {
  const payload = parsePayload({
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    cost: { total_cost_usd: 3.45 },
    context_window: { used_percentage: 24 },
  });
  const now = new Date(NOW_MS);
  const withNullIndex = renderLine(payload, now, { color: false, index: null });
  const rows = withNullIndex.split("\n");
  assert.match(rows[0] ?? "", /^limits .*ctx .* 24%/);
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

test("the spend segment shows the session's summed tokens next to its cost", () => {
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
  const { spend } = renderFleet(
    index,
    EMPTY_INDEX_PATH,
    "opus",
    2.14,
    month,
    NOW_MS,
    false,
    { sessionId: "abc" },
  );
  assert.match(spend, /ses 1\.2M \$2\.14/);
});

test("when the session is not in the store the spend segment falls back to cost only", () => {
  const index = makeIndexWithSession("abc", "/t/abc.jsonl", {}, 2.14);
  const month = new Date(NOW_MS).toISOString().slice(0, 7);
  const { spend } = renderFleet(
    index,
    EMPTY_INDEX_PATH,
    "opus",
    1.07,
    month,
    NOW_MS,
    false,
    { sessionId: "not-indexed-yet" },
  );
  assert.match(spend, /ses \$1\.07/);
  assert.ok(!/ses 0 /.test(spend), "must not print a 0-token spend segment");
});

// Month-scope + liveness behaviour. A fixed now sits inside June 2026; the
// session set straddles May and June so prior-month rows must be excluded from
// the counts. Liveness is asserted against the same fixed now.
const JUN_NOW_MS = Date.UTC(2026, 5, 15, 12, 0, 0);
const JUN_MONTH = "2026-06";
const MAY_TS = Date.UTC(2026, 4, 20, 10, 0, 0);
const JUN_IDLE_TS = JUN_NOW_MS - 10 * 60 * 1000;
const JUN_LIVE_TS = JUN_NOW_MS - 60 * 1000;

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

test("the fleet count head is the active class count·month total, plus the live segment", () => {
  const roster = renderRoster(
    TWO_MONTH_INDEX,
    "opus",
    JUN_MONTH,
    JUN_NOW_MS,
    false,
  );
  assert.strictEqual(roster, "opus 2·3 mo  live ●1 opus ●1 sonnet");
});

test("a fresh single-session fixture renders the month count, never an all-time 1·1", () => {
  const single = makeIndex(
    [{ modelClass: "opus", lastTs: JUN_IDLE_TS, costUsd: 1.0 }],
    0,
  );
  const roster = renderRoster(single, "opus", JUN_MONTH, JUN_NOW_MS, false);
  assert.strictEqual(roster, "opus 1·1 mo");

  const priorMonthOnly = makeIndex(
    [{ modelClass: "opus", lastTs: MAY_TS, costUsd: 1.0 }],
    0,
  );
  const emptyRoster = renderRoster(
    priorMonthOnly,
    "opus",
    JUN_MONTH,
    JUN_NOW_MS,
    false,
  );
  assert.strictEqual(
    emptyRoster,
    "opus 0·0 mo",
    "a session only in a prior month leaves the current month empty",
  );
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

test("live counts are independent of month scope across a month rollover", () => {
  // now is one minute into July; a session whose last_ts is one minute before
  // the rollover is still inside the liveness window though it belongs to June.
  const rolloverNow = Date.UTC(2026, 6, 1, 0, 1, 0);
  const juneEdgeTs = Date.UTC(2026, 5, 30, 23, 59, 0);
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

test("the active class's monthly spend is its own sessions only and Σ sums all classes", async () => {
  const dbPath = await buildSpendDb(SPEND_SESSIONS);
  const { active, total } = renderMonthly(dbPath, "opus", SPEND_MONTH, false);
  assert.strictEqual(active, "opus 1.0M $5.00");
  assert.strictEqual(total, "Σ 3.0M $11.00");
});

test("the Σ total reflects all classes even when the active class is the smaller one", async () => {
  const dbPath = await buildSpendDb(SPEND_SESSIONS);
  const { active, total } = renderMonthly(dbPath, "sonnet", SPEND_MONTH, false);
  assert.strictEqual(active, "sonnet 2.0M $6.00");
  assert.strictEqual(total, "Σ 3.0M $11.00");
});

test("an active class with no sessions this month renders 0 $0.00 while Σ reflects others", async () => {
  const dbPath = await buildSpendDb(SPEND_SESSIONS);
  const { active, total } = renderMonthly(dbPath, "haiku", SPEND_MONTH, false);
  assert.strictEqual(active, "haiku 0 $0.00");
  assert.strictEqual(total, "Σ 3.0M $11.00");
});

test("the active-class figure is dim and the Σ cost is bright", async () => {
  const dbPath = await buildSpendDb(SPEND_SESSIONS);
  const { active, total } = renderMonthly(dbPath, "opus", SPEND_MONTH, true);
  assert.ok(
    active.includes("\u001b[2mopus 1.0M $5.00\u001b[0m"),
    "active-class figure is dim",
  );
  assert.ok(
    total.includes("\u001b[97mΣ 3.0M $11.00\u001b[0m"),
    "Σ cost is bright",
  );
});
