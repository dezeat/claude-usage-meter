import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { compareDist } from "./check-dist.mjs";

test("committed runtime output must byte-match an isolated build", async () => {
  const root = await mkdtemp(join(tmpdir(), "dist-check-"));
  const committed = join(root, "committed");
  const built = join(root, "built");
  await mkdir(committed);
  await mkdir(built);
  await writeFile(join(committed, "pricing.js"), "old\n");
  await writeFile(join(built, "pricing.js"), "new\n");
  await assert.rejects(compareDist(committed, built), /pricing\.js/);
  await writeFile(join(committed, "pricing.js"), "new\n");
  await compareDist(committed, built);
});
