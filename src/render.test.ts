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

test("a full payload + index renders four rows labelled current, limits, spend, fleet in order", () => {
  const rows = fullRender(false).split("\n");
  assert.equal(rows.length, 4);
  assert.match(rows[0] ?? "", /^current /);
  assert.match(rows[1] ?? "", /^limits /);
  assert.match(rows[2] ?? "", /^spend /);
  assert.match(rows[3] ?? "", /^fleet /);
});

test("the current row shows the lowercased model and, given a location, repo ⎇ branch", () => {
  const line = renderLine(parsePayload(promax), fixtureNow, {
    color: false,
    location: { name: "claude-usage-meter", branch: "main" },
  });
  const now = line.split("\n")[0] ?? "";
  assert.match(now, /^current {2}opus 4\.8 · claude-usage-meter ⎇ main$/);
});

test("the current row drops the branch glyph outside a repo, showing the dir basename", () => {
  const line = renderLine(parsePayload(promax), fixtureNow, {
    color: false,
    location: { name: "some-dir" },
  });
  const now = line.split("\n")[0] ?? "";
  assert.match(now, /^current {2}opus 4\.8 · some-dir$/);
  assert.ok(!now.includes("⎇"), "no branch glyph without a branch");
});

test("the current row appends a worktree cue after repo ⎇ branch when inside a worktree", () => {
  const line = renderLine(parsePayload(promax), fixtureNow, {
    color: false,
    location: { name: "claude-usage-meter", branch: "side", worktree: "wt-1" },
  });
  const now = line.split("\n")[0] ?? "";
  assert.match(
    now,
    /^current {2}opus 4\.8 · claude-usage-meter ⎇ side ⌂ wt-1$/,
  );
});

test("the worktree cue is painted dim and distinct from the branch glyph", () => {
  const now =
    renderLine(parsePayload(promax), fixtureNow, {
      color: true,
      location: { name: "repo", branch: "side", worktree: "wt-1" },
    }).split("\n")[0] ?? "";
  assert.ok(now.includes(`${ANSI.dim}⌂${ANSI.reset}`), "dim worktree glyph");
});

test("a location without a worktree renders the current row unchanged", () => {
  const withWorktree = renderLine(parsePayload(promax), fixtureNow, {
    color: false,
    location: { name: "repo", branch: "main" },
  });
  const now = withWorktree.split("\n")[0] ?? "";
  assert.match(now, /^current {2}opus 4\.8 · repo ⎇ main$/);
  assert.ok(!now.includes("⌂"), "no worktree glyph without a worktree");
});

test("the current row carries the location alone when the model is unknown", () => {
  const line = renderLine(parsePayload({}), fixtureNow, {
    color: false,
    location: { name: "claude-usage-meter", branch: "main" },
  });
  assert.match(
    line.split("\n")[0] ?? "",
    /^current {2}claude-usage-meter ⎇ main$/,
  );
});

test("with neither model nor location the current row is omitted", () => {
  const line = renderLine(
    parsePayload({ cost: { total_cost_usd: 1 } }),
    fixtureNow,
    { color: false },
  );
  assert.ok(!line.startsWith("current "), "no leading current row");
  assert.ok(!line.includes("\ncurrent "), "no current row anywhere");
});

test("the limits row starts with ctx — the model is no longer pinned here", () => {
  const limits = fullRender(false).split("\n")[1] ?? "";
  assert.match(limits, /^limits {3}ctx /);
  assert.ok(!/^limits {3}opus/.test(limits), "no model pin on the limits row");
  assert.match(limits, /ctx .* 24%/);
  assert.match(limits, /5h .* 52% ⟳ 2h/);
  assert.match(limits, /7d .* 68% ⟳ 2d \(\w{2} \d\d\.\d\d\)$/);
  // Only the 7d cell carries the absolute reset day — exactly one "(" in the row.
  assert.equal((limits.match(/\(/g) ?? []).length, 1, "only 7d shows a date");
});

test("resolved cross-session limits override the payload's own 5h/7d, while ctx stays from the payload", () => {
  const fiveResets = promax.rate_limits.five_hour.resets_at;
  // Same reset instant (so the 2h countdown is unchanged), fresher usage from
  // another session: the row must render 80%, not the payload's 52%.
  const limits =
    renderLine(parsePayload(promax), fixtureNow, {
      color: false,
      index: populatedIndex(),
      indexPath: ":memory:",
      limits: {
        fiveHour: { usedPercentage: 80, resetsAt: fiveResets },
        sevenDay: { usedPercentage: 90, resetsAt: fiveResets + 2 * 24 * 3600 },
      },
    }).split("\n")[1] ?? "";
  assert.match(limits, /ctx .* 24%/, "ctx is the per-session payload value");
  assert.match(limits, /5h .* 80% ⟳ 2h/, "5h shows the resolved 80%");
  assert.ok(!limits.includes("52%"), "the payload's stale 5h is not rendered");
  assert.match(limits, /7d .* 90%/, "7d shows the resolved 90%");
});

test("an absent resolved window falls back to the payload's own snapshot", () => {
  // limits resolves only 5h; 7d is undefined, so the payload's 68% must show.
  const limits =
    renderLine(parsePayload(promax), fixtureNow, {
      color: false,
      index: populatedIndex(),
      indexPath: ":memory:",
      limits: {
        fiveHour: {
          usedPercentage: 80,
          resetsAt: promax.rate_limits.five_hour.resets_at,
        },
      },
    }).split("\n")[1] ?? "";
  assert.match(limits, /5h .* 80%/, "resolved 5h wins");
  assert.match(limits, /7d .* 68%/, "absent 7d falls back to the payload");
});

test("the spend row is cost-forward with the mdl self-label and Σ labels", () => {
  const spend = fullRender(false).split("\n")[2] ?? "";
  assert.match(spend, /ses \$3\.45 i:1\.0M\|c:0\|o:200\.0k/);
  assert.match(spend, /mdl \$/);
  assert.match(spend, /Σ \$/);
});

test("the fleet row leads with the mdl self-label count Σ total, no mo, plus active", () => {
  const fleet = fullRender(false).split("\n")[3] ?? "";
  assert.match(fleet, /mdl 1 Σ 1/);
  assert.ok(!fleet.includes("mo"), "the mo qualifier is dropped");
  assert.ok(!fleet.includes("/"), "the count cell uses ' Σ ', never a slash");
  // The current session is the only live opus → the active cell is omitted.
  assert.ok(
    !fleet.includes("active"),
    "self-only live tally drops active cell",
  );
});

test("multi-field rows join with a dot separator, none dangling", () => {
  const rows = fullRender(false).split("\n");
  // limits (ctx · 5h · 7d) and spend (ses · mdl · Σ) carry separators; the
  // current row is a single model cell and the fleet row a single count cell.
  assert.ok((rows[1] ?? "").includes(" · "), "limits joins its fields");
  assert.ok((rows[2] ?? "").includes(" · "), "spend joins its fields");
  for (const row of rows) {
    assert.ok(!row.endsWith(" · "), "no trailing separator");
    assert.ok(!/^\S+ {2}· /.test(row), "no leading separator after the label");
  }
});

test("fewer limit fields mean fewer separators with no dangling dot", () => {
  const degraded = renderLine(
    parsePayload(loadFixture("no-rate-limits-payload.json")),
    fixtureNow,
    { color: false },
  );
  const limits = degraded.split("\n")[1] ?? "";
  // Only ctx remains (no pin, no 5h/7d) → no field separator at all.
  const separators = limits.split(" · ").length - 1;
  assert.equal(separators, 0, "ctx alone has no separator");
  assert.ok(!limits.endsWith(" · "));
});

test("the cost is painted brightWhite ahead of its tokens in the spend row", () => {
  const spend = fullRender(true).split("\n")[2] ?? "";
  assert.ok(
    spend.includes(`${ANSI.brightWhite}$3.45${ANSI.reset}`),
    "the session cost is bright",
  );
});

test("every bar colours by the flat rule for both context and the limit bars", () => {
  // ctx 24% green, 5h 52% yellow, 7d 68% yellow.
  const limits = fullRender(true).split("\n")[1] ?? "";
  assert.ok(limits.includes(ANSI.green), "ctx at 24% is green");
  assert.ok(limits.includes(ANSI.yellow), "5h/7d in the 51-70 band are yellow");
  assert.ok(!limits.includes(ANSI.red), "nothing is in the red band here");
});

test("the limit bars keep the │ pace marker without it driving cell colour", () => {
  const limits = fullRender(true).split("\n")[1] ?? "";
  assert.ok(limits.includes("│"), "the pace marker is present on 5h/7d");
});

test("without rate_limits the limits row omits 5h/7d and the render still succeeds", () => {
  const degraded = renderLine(
    parsePayload(loadFixture("no-rate-limits-payload.json")),
    fixtureNow,
    { color: false },
  );
  const limits = degraded.split("\n")[1] ?? "";
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
  // Plain rows: the label prefix is exactly the 7-wide gutter then a 2-space gap.
  for (const row of fullRender(false).split("\n")) {
    assert.equal(row.slice(0, 7).trimEnd().length <= 7, true);
    assert.equal(
      row.slice(7, 9),
      "  ",
      "a 2-space gap follows the 7-wide gutter",
    );
  }
  // Painted rows: stripping the non-printing SGR codes recovers the same
  // 7-wide visible gutter — padding must not count the escape bytes.
  for (const row of fullRender(true).split("\n")) {
    const label = row.slice(0, row.indexOf("\x1b[0m") + 4);
    assert.equal(
      visibleLength(label),
      7,
      "visible gutter width is 7 with colour on",
    );
  }
});

test("row labels are painted accent", () => {
  for (const row of fullRender(true).split("\n")) {
    assert.ok(
      row.startsWith(ANSI.accent),
      "each row opens with the accent label colour",
    );
  }
});
