import { test } from "node:test";
import assert from "node:assert/strict";

import { ANSI } from "./ansi.js";
import {
  FIVE_HOUR_SECONDS,
  contextBar,
  elapsedFraction,
  formatCountdown,
  paceBar,
} from "./bars.js";

test("elapsed fraction is the share of the window already gone", () => {
  const resetsAt = 1900000000;
  const now = new Date((resetsAt - FIVE_HOUR_SECONDS * 0.4) * 1000);
  assert.ok(
    Math.abs(elapsedFraction(resetsAt, FIVE_HOUR_SECONDS, now) - 0.6) < 1e-9,
  );
});

test("elapsed fraction clamps to [0,1] outside the window", () => {
  const resetsAt = 1900000000;
  const past = new Date((resetsAt + 100) * 1000);
  const farFuture = new Date((resetsAt - FIVE_HOUR_SECONDS * 5) * 1000);
  assert.equal(elapsedFraction(resetsAt, FIVE_HOUR_SECONDS, past), 1);
  assert.equal(elapsedFraction(resetsAt, FIVE_HOUR_SECONDS, farFuture), 0);
});

test("burning ahead of pace reddens the overshoot cells", () => {
  const overPace = paceBar(78, 0.4, true);
  assert.ok(overPace.includes(ANSI.red), "expected red fill past the marker");
});

test("staying under pace keeps the bar green with no red", () => {
  const underPace = paceBar(40, 0.7, true);
  assert.ok(underPace.includes(ANSI.green), "expected green fill");
  assert.ok(!underPace.includes(ANSI.red), "expected no red while under pace");
});

test("the pace marker is always drawn", () => {
  assert.ok(paceBar(40, 0.7, false).includes("│"));
  assert.ok(paceBar(0, 0, false).includes("│"));
  assert.ok(paceBar(100, 1, false).includes("│"));
});

test("context bar colours by absolute fill, not pace", () => {
  assert.ok(contextBar(20, true).includes(ANSI.green));
  assert.ok(contextBar(65, true).includes(ANSI.yellow));
  assert.ok(contextBar(92, true).includes(ANSI.red));
});

test("countdown formats minutes, hours and days distinctly", () => {
  assert.equal(formatCountdown(0), "now");
  assert.equal(formatCountdown(47 * 60), "47m");
  assert.equal(formatCountdown(2 * 3600), "2h00m");
  assert.equal(formatCountdown(2 * 86400 + 3 * 3600), "2d3h");
});
