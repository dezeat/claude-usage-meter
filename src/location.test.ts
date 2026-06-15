import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveLocation } from "./location.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "location-test-"));
}

// A normal checkout: <repo>/.git/HEAD pointing at a branch.
function makeRepo(branchRef: string): string {
  const root = tmp();
  const gitDir = join(root, ".git");
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), branchRef, "utf8");
  return root;
}

test("inside a repo it reads the repo basename and the current branch", () => {
  const root = makeRepo("ref: refs/heads/feat/now-row\n");
  const loc = resolveLocation(root);
  assert.equal(loc?.name, root.split("/").pop());
  assert.equal(loc?.branch, "feat/now-row");
});

test("a nested subdirectory still resolves to the repo root and branch", () => {
  const root = makeRepo("ref: refs/heads/main\n");
  const deep = join(root, "src", "nested");
  mkdirSync(deep, { recursive: true });
  const loc = resolveLocation(deep);
  assert.equal(loc?.name, root.split("/").pop());
  assert.equal(loc?.branch, "main");
});

test("a detached HEAD (raw SHA) yields the repo name with no branch", () => {
  const root = makeRepo("9fceb02f1d3e4a5b6c7d8e9f0a1b2c3d4e5f6a7b\n");
  const loc = resolveLocation(root);
  assert.equal(loc?.name, root.split("/").pop());
  assert.equal(loc?.branch, undefined);
});

test("a linked worktree surfaces the true repo name, its branch and the worktree name", () => {
  // Lay out a main repo with a worktree git dir, and a separate worktree dir
  // whose `.git` is a file pointing at it — the shape `git worktree add` makes.
  // The gitdir path …/<repo>/.git/worktrees/<name> carries BOTH the true repo
  // name (basename two levels above worktrees/) and the linked-worktree name.
  const mainRoot = mkdtempSync(join(tmpdir(), "myrepo-"));
  const wtGitDir = join(mainRoot, ".git", "worktrees", "wt-feature");
  mkdirSync(wtGitDir, { recursive: true });
  writeFileSync(join(wtGitDir, "HEAD"), "ref: refs/heads/side\n", "utf8");

  const worktree = tmp();
  writeFileSync(join(worktree, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");

  const loc = resolveLocation(worktree);
  assert.equal(loc?.name, mainRoot.split("/").pop());
  assert.equal(loc?.branch, "side");
  assert.equal(loc?.worktree, "wt-feature");
});

test("the main working tree labels its worktree cell 'root'", () => {
  const root = makeRepo("ref: refs/heads/main\n");
  const loc = resolveLocation(root);
  assert.equal(loc?.worktree, "root");
});

test("outside any repo it falls back to the directory basename, no branch, no worktree", () => {
  const dir = tmp();
  const loc = resolveLocation(dir);
  assert.equal(loc?.name, dir.split("/").pop());
  assert.equal(loc?.branch, undefined);
  assert.equal(loc?.worktree, undefined);
});

test("an absent cwd yields no location at all", () => {
  assert.equal(resolveLocation(undefined), undefined);
  assert.equal(resolveLocation(""), undefined);
});
