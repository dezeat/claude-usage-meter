import { test } from "node:test";
import assert from "node:assert/strict";

import { type CrossSessionIndex } from "./index-store.js";
import { formatReport } from "./report.js";

const FIXTURE_INDEX: CrossSessionIndex = {
  sessions: {
    "/fake/session-a.jsonl": {
      sessionId: "session-a",
      branch: "main",
      modelClass: "sonnet",
      tokens: {
        "claude-sonnet-4-6": {
          inputTokens: 80000,
          outputTokens: 40000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
      costUsd: 2.8,
      lastTs: Date.parse("2026-06-12T10:00:00Z"),
      byteOffset: 1000,
      path: "/fake/session-a.jsonl",
    },
    "/fake/session-b.jsonl": {
      sessionId: "session-b",
      branch: "feat/foo",
      modelClass: "opus",
      tokens: {
        "claude-opus-4-8": {
          inputTokens: 60000,
          outputTokens: 30000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
      costUsd: 4.21,
      lastTs: Date.parse("2026-06-13T14:00:00Z"),
      byteOffset: 2000,
      path: "/fake/session-b.jsonl",
    },
  },
  byMonth: {
    "2026-06": {
      tokens: {
        "claude-sonnet-4-6": {
          inputTokens: 80000,
          outputTokens: 40000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        "claude-opus-4-8": {
          inputTokens: 60000,
          outputTokens: 30000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
      costUsd: 7.01,
    },
  },
  byBranch: {
    main: {
      tokens: {
        "claude-sonnet-4-6": {
          inputTokens: 80000,
          outputTokens: 40000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
      costUsd: 2.8,
    },
    "feat/foo": {
      tokens: {
        "claude-opus-4-8": {
          inputTokens: 60000,
          outputTokens: 30000,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      },
      costUsd: 4.21,
    },
  },
  updatedAt: Date.parse("2026-06-13T14:00:00Z"),
};

const NOW = new Date("2026-06-13T18:00:00Z");

test("report over fixture index contains per-day, per-class, and per-branch sections with values matching the fixture exactly", () => {
  const out = formatReport(FIXTURE_INDEX, NOW, false);

  assert.ok(out.includes("$7.01"), "billing total $7.01 missing");
  assert.ok(out.includes("$2.80"), "session-a cost $2.80 missing");
  assert.ok(out.includes("$4.21"), "session-b cost $4.21 missing");
  assert.ok(out.includes("main"), "branch main missing");
  assert.ok(out.includes("feat/foo"), "branch feat/foo missing");
  assert.ok(out.includes("sonnet"), "model class sonnet missing");
  assert.ok(out.includes("opus"), "model class opus missing");
  assert.ok(out.includes("By day"), "By day section header missing");
  assert.ok(
    out.includes("By model class"),
    "By model class section header missing",
  );
  assert.ok(out.includes("By branch"), "By branch section header missing");
});

test("sparkline maps daily series onto block ramp monotonically — min day gets ▁ and max day gets █", () => {
  // Three sessions on three different days with clearly ordered token counts:
  // day A (min): 10k total, day B (mid): 50k, day C (max): 200k
  const threeDay: CrossSessionIndex = {
    sessions: {
      "/d/a.jsonl": {
        sessionId: "a",
        branch: "main",
        modelClass: "sonnet",
        tokens: {
          "claude-sonnet-4-6": {
            inputTokens: 8000,
            outputTokens: 2000,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
        costUsd: 0.1,
        lastTs: Date.parse("2026-06-11T10:00:00Z"),
        byteOffset: 0,
        path: "/d/a.jsonl",
      },
      "/d/b.jsonl": {
        sessionId: "b",
        branch: "main",
        modelClass: "sonnet",
        tokens: {
          "claude-sonnet-4-6": {
            inputTokens: 40000,
            outputTokens: 10000,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
        costUsd: 0.5,
        lastTs: Date.parse("2026-06-12T10:00:00Z"),
        byteOffset: 0,
        path: "/d/b.jsonl",
      },
      "/d/c.jsonl": {
        sessionId: "c",
        branch: "main",
        modelClass: "sonnet",
        tokens: {
          "claude-sonnet-4-6": {
            inputTokens: 160000,
            outputTokens: 40000,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
        costUsd: 2.0,
        lastTs: Date.parse("2026-06-13T10:00:00Z"),
        byteOffset: 0,
        path: "/d/c.jsonl",
      },
    },
    byMonth: {},
    byBranch: {},
    updatedAt: 0,
  };

  const nowThreeDay = new Date("2026-06-13T18:00:00Z");
  const out = formatReport(threeDay, nowThreeDay, false);

  // Output rows are sorted descending by date, so:
  // line 0 = 2026-06-13 (max, █), line 1 = 2026-06-12 (mid), line 2 = 2026-06-11 (min, ▁)
  const lines = out.split("\n");
  const dayLines = lines.filter((l) => l.includes("2026-06-1"));
  assert.strictEqual(dayLines.length, 3, "expected 3 day rows");

  // max day (2026-06-13) should carry █
  const maxLine = dayLines.find((l) => l.includes("2026-06-13"));
  assert.ok(maxLine !== undefined, "max day line missing");
  assert.ok(maxLine.includes("█"), `max day must include █, got: ${maxLine}`);

  // min day (2026-06-11) should carry ▁
  const minLine = dayLines.find((l) => l.includes("2026-06-11"));
  assert.ok(minLine !== undefined, "min day line missing");
  assert.ok(minLine.includes("▁"), `min day must include ▁, got: ${minLine}`);
});

test("output contains no box-drawing frame characters", () => {
  const out = formatReport(FIXTURE_INDEX, NOW, false);
  assert.ok(!out.includes("│"), "│ frame character must not appear");
  assert.ok(!out.includes("┤"), "┤ frame character must not appear");
  assert.ok(!out.includes("├"), "├ frame character must not appear");
  assert.ok(!out.includes("┼"), "┼ frame character must not appear");
});

test("output contains no urgency color SGR codes on identity columns with color enabled", () => {
  const out = formatReport(FIXTURE_INDEX, NOW, true);
  assert.ok(!out.includes("\x1b[32m"), "green SGR must not appear");
  assert.ok(!out.includes("\x1b[33m"), "yellow SGR must not appear");
  assert.ok(!out.includes("\x1b[31m"), "red SGR must not appear");
});

test("billing-period total equals the sum of the per-day rows in that period", () => {
  const out = formatReport(FIXTURE_INDEX, NOW, false);
  // Per-day costs from the fixture: session-a ($2.80) on 2026-06-12,
  // session-b ($4.21) on 2026-06-13. Sum = $7.01.
  const perDaySum = 2.8 + 4.21;
  const billingLine = out.split("\n").find((l) => l.includes("Billing period"));
  assert.ok(billingLine !== undefined, "Billing period line missing");
  // Extract the dollar amount from the billing line
  const match = billingLine.match(/\$(\d+\.\d+)/);
  assert.ok(match !== null, "could not parse billing amount");
  const billingTotal = parseFloat(match[1] ?? "0");
  assert.ok(
    Math.abs(billingTotal - perDaySum) < 0.01,
    `billing total ${billingTotal} does not match per-day sum ${perDaySum}`,
  );
});

test("empty index produces section headers with empty roll-up and does not throw", () => {
  const emptyIndex: CrossSessionIndex = {
    sessions: {},
    byMonth: {},
    byBranch: {},
    updatedAt: 0,
  };

  let out: string;
  assert.doesNotThrow(() => {
    out = formatReport(emptyIndex, NOW, false);
  }, "formatReport must not throw on empty index");

  assert.ok(out!.includes("By day"), "By day header must appear");
  assert.ok(
    out!.includes("By model class"),
    "By model class header must appear",
  );
  assert.ok(out!.includes("By branch"), "By branch header must appear");
  assert.ok(out!.includes("Billing period"), "Billing period line must appear");
});
