import { test } from "node:test";
import assert from "node:assert/strict";

import { type UsageByModel } from "./aggregate.js";
import { cost, DEFAULT_PRICING, type PricingTable } from "./pricing.js";

function oneMillionInput(model: string): UsageByModel {
  return {
    models: {
      [model]: {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    },
    skippedLines: 0,
  };
}

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

test("current Opus bills 1M input tokens at its $5 rate", () => {
  const result = cost(oneMillionInput("claude-opus-4-8"), DEFAULT_PRICING);
  assert.equal(result.totalUsd, 5);
  assert.equal(result.hasUnknownModels, false);
});

test("a date-suffixed model id is priced via its dateless alias", () => {
  const result = cost(
    oneMillionInput("claude-haiku-4-5-20251001"),
    DEFAULT_PRICING,
  );
  assert.equal(result.totalUsd, 1); // Haiku 4.5 input is $1/MTok
  assert.equal(result.perModel[0]?.known, true);
});

test("deprecated Opus 4.1 keeps its legacy $15 input rate, not the current $5", () => {
  assert.equal(
    cost(oneMillionInput("claude-opus-4-1"), DEFAULT_PRICING).totalUsd,
    15,
  );
  assert.equal(
    cost(oneMillionInput("claude-opus-4-1-20250805"), DEFAULT_PRICING).totalUsd,
    15,
  );
});

test("Mythos 5 is priced at the same rate as Fable 5", () => {
  assert.equal(
    cost(oneMillionInput("claude-mythos-5"), DEFAULT_PRICING).totalUsd,
    10,
  );
});

test("current Sonnet 5 bills 1M input tokens at the $3 Sonnet rate", () => {
  const result = cost(oneMillionInput("claude-sonnet-5"), DEFAULT_PRICING);
  assert.equal(result.totalUsd, 3); // published standard rate $3/MTok input
  assert.equal(result.perModel[0]?.known, true);
});
