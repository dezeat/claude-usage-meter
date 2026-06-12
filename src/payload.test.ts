import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePayload } from "./payload.js";

test("a full Pro/Max payload narrows to every field", () => {
  const parsed = parsePayload({
    model: { id: "claude-opus-4-8", display_name: "Opus 4.8" },
    cost: { total_cost_usd: 3.45 },
    context_window: { used_percentage: 24 },
    rate_limits: {
      five_hour: { used_percentage: 52, resets_at: 1900000000 },
      seven_day: { used_percentage: 68, resets_at: 1900176400 },
    },
  });

  assert.equal(parsed.modelName, "Opus 4.8");
  assert.equal(parsed.contextPercentage, 24);
  assert.equal(parsed.costUsd, 3.45);
  assert.deepEqual(parsed.fiveHour, {
    usedPercentage: 52,
    resetsAt: 1900000000,
  });
  assert.deepEqual(parsed.sevenDay, {
    usedPercentage: 68,
    resetsAt: 1900176400,
  });
});

test("absent rate_limits leaves both windows undefined", () => {
  const parsed = parsePayload({
    model: { display_name: "Opus 4.8" },
    cost: { total_cost_usd: 1.07 },
    context_window: { used_percentage: 13 },
  });

  assert.equal(parsed.fiveHour, undefined);
  assert.equal(parsed.sevenDay, undefined);
  assert.equal(parsed.modelName, "Opus 4.8");
});

test("a window missing resets_at is dropped rather than half-parsed", () => {
  const parsed = parsePayload({
    rate_limits: { five_hour: { used_percentage: 52 } },
  });

  assert.equal(parsed.fiveHour, undefined);
});

test("wrong-typed fields are ignored, not coerced", () => {
  const parsed = parsePayload({
    model: { display_name: 42 },
    cost: { total_cost_usd: "3.45" },
    context_window: { used_percentage: Number.NaN },
  });

  assert.equal(parsed.modelName, undefined);
  assert.equal(parsed.costUsd, undefined);
  assert.equal(parsed.contextPercentage, undefined);
});

test("a non-object payload parses to an empty result", () => {
  assert.deepEqual(parsePayload(null), {
    modelName: undefined,
    contextPercentage: undefined,
    costUsd: undefined,
    fiveHour: undefined,
    sevenDay: undefined,
  });
  assert.deepEqual(parsePayload("nonsense").fiveHour, undefined);
});
