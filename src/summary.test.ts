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
