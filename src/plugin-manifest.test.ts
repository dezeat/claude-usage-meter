import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// These read the repo's own files rather than any module under test: they guard
// the two invariants that no unit test can see and that only break at publish
// time — the manifests agreeing, and the runtime staying offline. Once the plugin
// is listed, the catalogue pin auto-follows `main`, so a regression here ships.

function repoFile(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

function repoJson(relative: string): Record<string, unknown> {
  return JSON.parse(repoFile(relative)) as Record<string, unknown>;
}

function marketplaceEntry(): Record<string, unknown> {
  const marketplace = repoJson(".claude-plugin/marketplace.json");
  const plugins = marketplace.plugins as Record<string, unknown>[];
  const entry = plugins.find((p) => p.name === "claude-usage-meter");
  assert.ok(entry, "the marketplace lists a claude-usage-meter entry");
  return entry;
}

test("the three manifests declare the same version", () => {
  const pkg = repoJson("package.json");
  const plugin = repoJson(".claude-plugin/plugin.json");

  assert.equal(
    plugin.version,
    pkg.version,
    "plugin.json must match package.json — an install only updates when this bumps",
  );
  assert.equal(
    marketplaceEntry().version,
    pkg.version,
    "the marketplace entry must match package.json",
  );
});

test("plugin and marketplace agree on the identity a browsing user sees", () => {
  const plugin = repoJson(".claude-plugin/plugin.json");
  const entry = marketplaceEntry();

  assert.equal(
    entry.name,
    plugin.name,
    "the install slug is immutable once published",
  );
  assert.equal(
    entry.description,
    plugin.description,
    "a drifted description shows one text in the catalogue and another on install",
  );
  assert.deepEqual(
    entry.keywords,
    plugin.keywords,
    "search keywords must not drift",
  );
});

test("the plugin manifest carries every field the catalogue renders", () => {
  const plugin = repoJson(".claude-plugin/plugin.json");
  for (const field of [
    "name",
    "displayName",
    "description",
    "version",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
  ]) {
    assert.ok(plugin[field], `plugin.json must declare ${field}`);
  }
});

test("no source file imports a network or subprocess capability", () => {
  // The zero-network, zero-dependency promise is the product's core claim
  // (CLAUDE.md). Asserting it here makes it a gate rather than a habit.
  const forbidden =
    /from\s+["']node:(net|http|https|dns|tls|dgram|child_process|worker_threads)["']|require\(\s*["']node:(net|http|https|dns|tls|dgram|child_process)["']|\bfetch\s*\(/;

  const srcDir = new URL("../src/", import.meta.url);
  const offenders: string[] = [];
  for (const name of readdirSync(fileURLToPath(srcDir))) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    if (forbidden.test(readFileSync(new URL(name, srcDir), "utf8"))) {
      offenders.push(name);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these files reach the network or spawn processes",
  );
});
