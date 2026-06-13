import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ANSI, visibleLength } from "./ansi.js";
import { parsePayload } from "./payload.js";
import { PLACEHOLDER_LINE, renderLine } from "./render.js";
import { type CrossSessionIndex } from "./index-store.js";

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

const NOW_MS = fixtureNow.getTime();
const MONTH = fixtureNow.toISOString().slice(0, 7);

// A populated in-memory index with one live opus session, so the spend/fleet
// rows have data to render. monthClassCounts/liveClassCounts read sessions; the
// monthly Σ spend reads the (empty) :memory: db path, which yields zeros — the
// row still renders, which is all these layout tests assert.
function populatedIndex(): CrossSessionIndex {
  return {
    sessions: {
      "fixture-session-0001": {
        path: "/tmp/usage-meter-fixture/session.jsonl",
        sessionId: "fixture-session-0001",
        branch: "main",
        modelClass: "opus",
        tokens: {
          "claude-opus-4-8": {
            inputTokens: 1_000_000,
            outputTokens: 200_000,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        },
        costUsd: 3.45,
        lastTs: NOW_MS,
        byteOffset: 0,
      },
    },
    byMonth: { [MONTH]: { tokens: {}, costUsd: 3.45 } },
    byBranch: {},
    updatedAt: NOW_MS,
  };
}

function fullRender(color: boolean): string {
  return renderLine(parsePayload(promax), fixtureNow, {
    color,
    index: populatedIndex(),
    indexPath: ":memory:",
  });
}

test("placeholder is a non-empty single line", () => {
  assert.ok(PLACEHOLDER_LINE.length > 0);
  assert.ok(!PLACEHOLDER_LINE.includes("\n"));
});

test("a full payload + index renders three rows labelled limits, spend, fleet in order", () => {
  const rows = fullRender(false).split("\n");
  assert.equal(rows.length, 3);
  assert.match(rows[0] ?? "", /^limits /);
  assert.match(rows[1] ?? "", /^spend /);
  assert.match(rows[2] ?? "", /^fleet /);
});

test("the limits row carries ctx, 5h and 7d with percentages and countdowns", () => {
  const limits = fullRender(false).split("\n")[0] ?? "";
  assert.match(limits, /ctx .* 24%/);
  assert.match(limits, /5h .* 52% ⟳2h00m/);
  assert.match(limits, /7d .* 68% ⟳2d3h/);
});

test("the spend row carries the session tokens, the active class and the Σ total", () => {
  const spend = fullRender(false).split("\n")[1] ?? "";
  assert.match(spend, /ses 1\.2M \$3\.45/);
  assert.match(spend, /opus /);
  assert.match(spend, /Σ /);
});

test("the fleet row carries the active class count and the live segment", () => {
  const fleet = fullRender(false).split("\n")[2] ?? "";
  assert.match(fleet, /opus 1·1 mo/);
  assert.match(fleet, /live ●1 opus/);
});

test("every bar colours by the flat rule for both context and the limit bars", () => {
  // ctx 24% green, 5h 52% yellow, 7d 68% yellow.
  const limits = fullRender(true).split("\n")[0] ?? "";
  assert.ok(limits.includes(ANSI.green), "ctx at 24% is green");
  assert.ok(limits.includes(ANSI.yellow), "5h/7d in the 51-70 band are yellow");
  assert.ok(!limits.includes(ANSI.red), "nothing is in the red band here");
});

test("the limit bars keep the │ pace marker without it driving cell colour", () => {
  const limits = fullRender(true).split("\n")[0] ?? "";
  assert.ok(limits.includes("│"), "the pace marker is present on 5h/7d");
});

test("without rate_limits the limits row omits 5h/7d and the render still succeeds", () => {
  const degraded = renderLine(
    parsePayload(loadFixture("no-rate-limits-payload.json")),
    fixtureNow,
    { color: false },
  );
  const limits = degraded.split("\n")[0] ?? "";
  assert.match(limits, /^limits /);
  assert.match(limits, /ctx .* 13%/);
  assert.ok(!limits.includes("5h"));
  assert.ok(!limits.includes("7d"));
});

test("with no index the fleet and spend-fleet segments are omitted", () => {
  const noIndex = renderLine(parsePayload(promax), fixtureNow, {
    color: false,
  });
  assert.ok(!noIndex.includes("\nfleet"), "no fleet row without an index");
  // The only spend content without an index is the raw payload cost, never the
  // active-class or Σ figures, which are index-derived.
  assert.ok(!noIndex.includes("Σ"), "no Σ total without an index");
  assert.ok(!noIndex.includes("·1 mo"), "no fleet counts without an index");
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

test("row labels pad to a common visible width with colour on and off", () => {
  // Plain rows: the label prefix is exactly the 6-wide gutter ("limits").
  for (const row of fullRender(false).split("\n")) {
    assert.equal(row.slice(0, 6).trimEnd().length <= 6, true);
    assert.equal(
      row.charAt(6),
      " ",
      "a single space follows the 6-wide gutter",
    );
  }
  // Painted rows: stripping the non-printing SGR codes recovers the same
  // 6-wide visible gutter — padding must not count the escape bytes.
  for (const row of fullRender(true).split("\n")) {
    const label = row.slice(0, row.indexOf("\x1b[0m") + 4);
    assert.equal(
      visibleLength(label),
      6,
      "visible gutter width is 6 with colour on",
    );
  }
});
