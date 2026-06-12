import { test } from "node:test";
import assert from "node:assert/strict";

import { type UsageByModel } from "./aggregate.js";
import { cost, type PricingTable } from "./pricing.js";

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

test("cost sums each token class at its per-million rate", () => {
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

  // (1000*5 + 2000*25 + 3000*0.5 + 4000*6.25) / 1e6 = 0.0815
  const result = cost(usage, table);
  assert.equal(result.perModel[0]?.costUsd, 0.0815);
  assert.equal(result.totalUsd, 0.0815);
  assert.equal(result.hasUnknownModels, false);
});

test("an unknown model is flagged, priced at zero, and left out of the total", () => {
  const usage: UsageByModel = {
    models: {
      "model-a": {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      "mystery-model": {
        inputTokens: 9_999_999,
        outputTokens: 9_999_999,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    },
    skippedLines: 0,
  };

  const result = cost(usage, table);
  const mystery = result.perModel.find(
    (entry) => entry.model === "mystery-model",
  );

  assert.equal(result.hasUnknownModels, true);
  assert.equal(mystery?.known, false);
  assert.equal(mystery?.costUsd, 0);
  assert.equal(result.totalUsd, 5); // only model-a's 1M input tokens at $5
});
