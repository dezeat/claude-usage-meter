import { test } from "node:test";
import assert from "node:assert/strict";

import { ANSI } from "./ansi.js";
import {
  FIVE_HOUR_SECONDS,
  contextBar,
  elapsedFraction,
  fillColor,
  formatCountdown,
  formatResetDate,
  paceBar,
} from "./bars.js";

// formatResetDate reads the reset timestamp in the host's local timezone; pin it
// to UTC so the weekday/date assertion below is deterministic everywhere (CI
// already runs UTC, this covers dev machines too). The other bars tests use only
// relative-second math and are timezone-independent.
process.env.TZ = "UTC";

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

test("the flat rule is green at 50, yellow at 70, red above", () => {
  assert.equal(fillColor(40), "green");
  assert.equal(fillColor(50), "green");
  assert.equal(fillColor(60), "yellow");
  assert.equal(fillColor(70), "yellow");
  assert.equal(fillColor(85), "red");
  assert.equal(fillColor(71), "red");
});

test("the pace bar colours by absolute fill, not by pace overshoot", () => {
  // Same 40% fill, opposite pace fractions — both green under the flat rule.
  const behind = paceBar(40, 0.1, true);
  const ahead = paceBar(40, 0.9, true);
  assert.ok(behind.includes(ANSI.green));
  assert.ok(ahead.includes(ANSI.green));
  assert.ok(
    !behind.includes(ANSI.red),
    "no overshoot reddening under flat rule",
  );
  assert.ok(
    !ahead.includes(ANSI.red),
    "no overshoot reddening under flat rule",
  );
});

test("a 5h/7d bar reddens at high fill and yellows in the middle band", () => {
  assert.ok(paceBar(60, 0.5, true).includes(ANSI.yellow));
  assert.ok(paceBar(85, 0.5, true).includes(ANSI.red));
  // ≥ 90 no longer forces special behaviour beyond the flat red band.
  assert.ok(!paceBar(85, 0.5, true).includes(ANSI.green));
});

test("the pace marker is always drawn and does not change cell colour", () => {
  assert.ok(paceBar(40, 0.7, false).includes("│"));
  assert.ok(paceBar(0, 0, false).includes("│"));
  assert.ok(paceBar(100, 1, false).includes("│"));

  // Remove the painted marker token (brightWhite │ reset) so only the coloured
  // fill/empty cells remain, then assert they are byte-identical for the same
  // fill across two pace fractions: colour is the flat rule, only the marker moves.
  const marker = `${ANSI.brightWhite}│${ANSI.reset}`;
  const cells = (bar: string): string => bar.split(marker).join("");
  assert.equal(cells(paceBar(60, 0.2, true)), cells(paceBar(60, 0.9, true)));
});

test("context bar colours by absolute fill under the flat rule", () => {
  assert.ok(contextBar(40, true).includes(ANSI.green));
  assert.ok(contextBar(60, true).includes(ANSI.yellow));
  assert.ok(contextBar(85, true).includes(ANSI.red));
});

test("countdown shows a unit only when at least one of it remains — never a zero component", () => {
  assert.equal(formatCountdown(0), "now");
  assert.equal(formatCountdown(0.4), "now");
  assert.equal(formatCountdown(42), "42s");
  assert.equal(formatCountdown(47 * 60), "47m");
  assert.equal(formatCountdown(3 * 3600 + 5 * 60), "3h05m");
  assert.equal(formatCountdown(2 * 3600), "2h");
  assert.equal(formatCountdown(2 * 86400 + 3 * 3600), "2d3h");
  assert.equal(formatCountdown(2 * 86400), "2d");
});

test("the reset date is the weekday and zero-padded DD.MM of the reset day", () => {
  // 2026-06-16 is a Tuesday (calendar oracle); with TZ pinned to UTC the local
  // components equal the UTC ones, so the formatted day is deterministic.
  const resetsAt = Date.UTC(2026, 5, 16) / 1000; // month index 5 = June
  assert.equal(formatResetDate(resetsAt), "Tu 16.06");
});
