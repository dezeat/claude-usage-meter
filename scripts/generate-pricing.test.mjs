import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { generate, renderRegister } from "./generate-pricing.mjs";

const valid = {
  schemaVersion: 1,
  asOf: "2026-07-28",
  models: [
    {
      id: "claude-opus-4-8",
      class: "opus",
      standard: { inputUsdPerMTok: "5", outputUsdPerMTok: "25" },
    },
  ],
};

test("canonical input renders deterministically with exact cache multiples", () => {
  const source = JSON.stringify(valid);
  const first = renderRegister(source);
  assert.equal(renderRegister(source), first);
  assert.match(first, /cacheReadPerMTok: 0\.5/);
  assert.match(first, /cacheCreationPerMTok: 6\.25/);
});

test("unknown fields, noncanonical decimals, ordering, and inexact cache rates fail closed", () => {
  for (const mutate of [
    (copy) => {
      copy.extra = true;
    },
    (copy) => {
      copy.models[0].standard.inputUsdPerMTok = "5.0";
    },
    (copy) => {
      copy.models.push({ ...copy.models[0], id: "claude-a" });
    },
    (copy) => {
      copy.models[0].standard.inputUsdPerMTok = "0.000001";
    },
    (copy) => {
      copy.models[0] = {
        class: "opus",
        id: "claude-opus-4-8",
        standard: copy.models[0].standard,
      };
    },
  ]) {
    const copy = structuredClone(valid);
    mutate(copy);
    assert.throws(
      () => renderRegister(JSON.stringify(copy)),
      /invalid pricing register/,
    );
  }
});

test("unsafe numeric magnitudes and malformed canonical IDs fail closed", () => {
  const boundary = structuredClone(valid);
  boundary.models[0].standard.outputUsdPerMTok = "900719925.474099";
  const boundaryOutput = renderRegister(JSON.stringify(boundary));
  assert.match(boundaryOutput, /900719925\.474099/);
  assert.doesNotMatch(boundaryOutput, /Infinity/);

  for (const input of [
    "9007199254.740992",
    "999999999999999999999999999999999999",
  ]) {
    const copy = structuredClone(valid);
    copy.models[0].standard.inputUsdPerMTok = input;
    assert.throws(
      () => renderRegister(JSON.stringify(copy)),
      /exact finite runtime representation|round-trip exactly/,
    );
  }
  for (const id of ["claude--opus-4-8", "claude-opus-4-8-"]) {
    const copy = structuredClone(valid);
    copy.models[0].id = id;
    assert.throws(() => renderRegister(JSON.stringify(copy)), /canonical id/);
  }
});

test("validation failure and check mode never write output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pricing-generator-"));
  await mkdir(join(root, "pricing"));
  await mkdir(join(root, "src/generated"), { recursive: true });
  const output = join(root, "src/generated/pricing-register.ts");
  await writeFile(output, "sentinel\n");
  await writeFile(join(root, "pricing/models.json"), "{}");
  await assert.rejects(generate(root, false), /invalid pricing register/);
  assert.equal(await readFile(output, "utf8"), "sentinel\n");
  await writeFile(join(root, "pricing/models.json"), JSON.stringify(valid));
  await assert.rejects(generate(root, true), /stale/);
  assert.equal(await readFile(output, "utf8"), "sentinel\n");
  await generate(root, false);
  const generated = await readFile(output, "utf8");
  await generate(root, false);
  assert.equal(await readFile(output, "utf8"), generated);
  await generate(root, true);
});
