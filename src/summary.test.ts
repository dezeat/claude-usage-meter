import { test } from "node:test";
import assert from "node:assert/strict";

import { type UsageByModel } from "./aggregate.js";
import { cost, type PricingTable } from "./pricing.js";
import { renderSummary } from "./summary.js";

const table: PricingTable = {
  asOf: "2026-01-01",
  rates: {
    "model-a": {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
      cacheCreationPerMTok: 6.25,
    },
  },
};

test("the box shows each model, the total, and the pricing date", () => {
  const usage: UsageByModel = {
    models: {
      "model-a": {
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 3000,
        cacheCreationTokens: 4000,
      },
    },
    skippedLines: 0,
  };
  const summary = renderSummary(usage, cost(usage, table), table);

  assert.match(summary, /model-a/);
  assert.match(summary, /total {2}\$0\.08/);
  assert.match(summary, /asOf 2026-01-01/);
  assert.ok(summary.startsWith("┌") && summary.includes("└"));
});

test("the session total carries the four-way token split and the cache-read share that explains the cost", () => {
  // Cache-read-dominated session across two models; hand-computed totals (the
  // oracle), consistent with ccusage's four-way accounting:
  //   a: in 8_000  out 3_000  cacheRead 600_000  cacheCreate 13_000
  //   b: in 4_000  out 2_000  cacheRead 360_000  cacheCreate 10_000
  //   Σ  in 12_000 out 5_000  cacheRead 960_000  cacheCreate 23_000
  //   = 1_000_000 total; cache reads are 960_000 / 1_000_000 = 96%.
  const cacheTable: PricingTable = {
    asOf: "2026-01-01",
    rates: {
      "model-a": {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cacheCreationPerMTok: 6.25,
      },
      "model-b": {
        inputPerMTok: 5,
        outputPerMTok: 25,
        cacheReadPerMTok: 0.5,
        cacheCreationPerMTok: 6.25,
      },
    },
  };
  const usage: UsageByModel = {
    models: {
      "model-a": {
        inputTokens: 8_000,
        outputTokens: 3_000,
        cacheReadTokens: 600_000,
        cacheCreationTokens: 13_000,
      },
      "model-b": {
        inputTokens: 4_000,
        outputTokens: 2_000,
        cacheReadTokens: 360_000,
        cacheCreationTokens: 10_000,
      },
    },
    skippedLines: 0,
  };
  const summary = renderSummary(usage, cost(usage, cacheTable), cacheTable);

  assert.match(summary, /in 12\.0k/);
  assert.match(summary, /out 5\.0k/);
  assert.match(summary, /960\.0k r/);
  assert.match(summary, /23\.0k w/);
  assert.match(summary, /96% cache reads/);
});

test("an unpriced model is flagged in the box and excluded from the total", () => {
  const usage: UsageByModel = {
    models: {
      "mystery-model": {
        inputTokens: 1000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    },
    skippedLines: 0,
  };
  const summary = renderSummary(usage, cost(usage, table), table);

  assert.match(summary, /mystery-model/);
  assert.match(summary, /⚠/);
  assert.match(summary, /excludes ⚠ unpriced/);
});
