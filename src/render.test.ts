import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ANSI } from "./ansi.js";
import { parsePayload } from "./payload.js";
import { PLACEHOLDER_LINE, renderLine } from "./render.js";

function loadFixture(name: string): unknown {
  const url = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

const promax = loadFixture("promax-payload.json") as {
  rate_limits: { five_hour: { resets_at: number } };
};
// Anchor "now" 2h before the 5-hour reset so the countdown is deterministic.
const fixtureNow = new Date(
  (promax.rate_limits.five_hour.resets_at - 2 * 3600) * 1000,
);

test("placeholder is a non-empty single line", () => {
  assert.ok(PLACEHOLDER_LINE.length > 0);
  assert.ok(!PLACEHOLDER_LINE.includes("\n"));
});

test("the Pro/Max line shows both limits with percentages and countdowns", () => {
  const line = renderLine(parsePayload(promax), fixtureNow, { color: false });

  assert.match(line, /Opus 4\.8/);
  assert.match(line, /ctx .* 24%/);
  assert.match(line, /5h .* 52% ⟳ 2h00m/);
  assert.match(line, /7d .* 68% ⟳ 2d3h/);
  assert.match(line, /\$3\.45/);
  assert.ok(!line.includes("\n"));
});

test("an over-pace limit reddens its bar; an under-pace one does not", () => {
  const overPace = renderLine(
    parsePayload({
      rate_limits: {
        five_hour: {
          used_percentage: 80,
          resets_at: promax.rate_limits.five_hour.resets_at,
        },
      },
    }),
    fixtureNow,
    { color: true },
  );
  const underPace = renderLine(
    parsePayload({
      rate_limits: {
        five_hour: {
          used_percentage: 20,
          resets_at: promax.rate_limits.five_hour.resets_at,
        },
      },
    }),
    fixtureNow,
    { color: true },
  );

  assert.ok(overPace.includes(ANSI.red));
  assert.ok(!underPace.includes(ANSI.red));
});

test("without rate_limits the line degrades to model, context and cost", () => {
  const degraded = renderLine(
    parsePayload(loadFixture("no-rate-limits-payload.json")),
    fixtureNow,
    {
      color: false,
    },
  );

  assert.match(degraded, /Opus 4\.8/);
  assert.match(degraded, /ctx .* 13%/);
  assert.match(degraded, /\$1\.07/);
  assert.ok(!degraded.includes("5h"));
  assert.ok(!degraded.includes("7d"));
});

test("an empty payload still renders a model fallback rather than throwing", () => {
  assert.doesNotThrow(() =>
    renderLine(parsePayload({}), fixtureNow, { color: false }),
  );
  assert.match(
    renderLine(parsePayload({}), fixtureNow, { color: false }),
    /Claude/,
  );
});
