import { test } from "node:test";
import assert from "node:assert/strict";

import { limitPill } from "./meters.js";

test("under NO_COLOR the pill keeps the value in brackets, dropping only the ramp", () => {
  assert.equal(limitPill(85, false), "[85%]");
  assert.equal(limitPill(40, false), "[40%]");
});

test("a coloured pill carries its percentage and a severity background", () => {
  const pill = limitPill(85, true);
  assert.ok(pill.includes("85%"), `value missing: ${pill}`);
  assert.ok(pill.includes("\x1b[41m"), `red background missing: ${pill}`);
});

test("the pill background follows the same flat thresholds as the bars", () => {
  // Boundaries mirror bars.ts fillColor: 50 green, 51 yellow, 70 yellow, 71 red.
  assert.ok(limitPill(50, true).includes("\x1b[42m"), "50 → green");
  assert.ok(limitPill(51, true).includes("\x1b[43m"), "51 → yellow");
  assert.ok(limitPill(70, true).includes("\x1b[43m"), "70 → yellow");
  assert.ok(limitPill(71, true).includes("\x1b[41m"), "71 → red");
  assert.ok(limitPill(60, true).includes("\x1b[43m"), "60 → yellow");
  assert.ok(limitPill(40, true).includes("\x1b[42m"), "40 → green");
});

test("the pill rounds a fractional percentage to a whole number", () => {
  assert.equal(limitPill(84.6, false), "[85%]");
});
