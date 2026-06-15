import { test } from "node:test";
import assert from "node:assert/strict";

import { type ModelUsage } from "./aggregate.js";
import {
  cacheReadShare,
  formatUsd,
  sumUsage,
  tokenBreakdown,
} from "./format.js";

// Synthetic fixture mirroring the cache-read-dominated agentic profile from the
// ticket. Hand-computed sums (the oracle), consistent with ccusage's four-way
// input/output/cache-read/cache-create accounting:
//   input 12_000 + output 5_000 + cacheRead 960_000 + cacheCreate 23_000
//   = 1_000_000 total; cache reads are 960_000 / 1_000_000 = 96%.
const PROFILE: ModelUsage = {
  inputTokens: 12_000,
  outputTokens: 5_000,
  cacheReadTokens: 960_000,
  cacheCreationTokens: 23_000,
};

test("the breakdown surfaces all four token kinds — input, output, cache read, cache create", () => {
  const line = tokenBreakdown(PROFILE);
  assert.ok(line.includes("in 12.0k"), `input slice missing: ${line}`);
  assert.ok(line.includes("out 5.0k"), `output slice missing: ${line}`);
  assert.ok(line.includes("960.0k r"), `cache-read slice missing: ${line}`);
  assert.ok(line.includes("23.0k w"), `cache-create slice missing: ${line}`);
});

test("the cache-read share is the cache-read fraction of all four token kinds, whole-percent", () => {
  // 960_000 / 1_000_000 = 96%.
  assert.strictEqual(cacheReadShare(PROFILE), 96);
});

test("the cache-read share is undefined when there are no tokens, so callers omit a meaningless 0%", () => {
  const empty: ModelUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  assert.strictEqual(cacheReadShare(empty), undefined);
});

test("a dollar figure renders as $d.dd — two fixed decimals, no separator (hand-computed)", () => {
  assert.strictEqual(formatUsd(3.4), "$3.40");
  assert.strictEqual(formatUsd(0), "$0.00");
  assert.strictEqual(formatUsd(1234.5), "$1234.50");
});

test("summing a per-model token map adds each of the four kinds independently", () => {
  // Two models whose four kinds sum to the PROFILE totals above:
  //   a: in 8_000  out 3_000  cacheRead 600_000  cacheCreate 13_000
  //   b: in 4_000  out 2_000  cacheRead 360_000  cacheCreate 10_000
  const perModel: Record<string, ModelUsage> = {
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
  };
  assert.deepStrictEqual(sumUsage(perModel), PROFILE);
});
