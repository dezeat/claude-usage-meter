import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cost } from "../dist/pricing.js";

import { generate, renderRegister } from "./generate-pricing.mjs";

const valid = {
  schemaVersion: 2,
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

test("every standard and fast cache derivative must be exact and safely representable", () => {
  for (const [tier, input] of [
    ["standard", "9007199254.74098"],
    ["fast", "9007199254.74098"],
    ["standard", "0.000004"],
    ["fast", "0.000004"],
    ["standard", "0.00001"],
    ["fast", "0.00001"],
  ]) {
    const copy = structuredClone(valid);
    if (tier === "fast") {
      copy.models[0].fast = {
        inputUsdPerMTok: input,
        outputUsdPerMTok: "25",
      };
    } else {
      copy.models[0].standard.inputUsdPerMTok = input;
    }
    assert.throws(
      () => renderRegister(JSON.stringify(copy)),
      /cache rates are not exact|exact finite runtime representation/,
      `${tier} input ${input}`,
    );
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
  assert.deepEqual(await readdir(join(root, "src/generated")), [
    "pricing-register.ts",
  ]);
  const unsafeDerivative = structuredClone(valid);
  unsafeDerivative.models[0].standard.inputUsdPerMTok = "9007199254.74098";
  await writeFile(
    join(root, "pricing/models.json"),
    JSON.stringify(unsafeDerivative),
  );
  await assert.rejects(generate(root, false), /exact finite runtime/);
  assert.equal(await readFile(output, "utf8"), "sentinel\n");
  assert.deepEqual(await readdir(join(root, "src/generated")), [
    "pricing-register.ts",
  ]);
  await writeFile(join(root, "pricing/models.json"), JSON.stringify(valid));
  await assert.rejects(generate(root, true), /stale/);
  assert.equal(await readFile(output, "utf8"), "sentinel\n");
  await generate(root, false);
  const generated = await readFile(output, "utf8");
  await generate(root, false);
  assert.equal(await readFile(output, "utf8"), generated);
  await generate(root, true);
});

async function generatedPricing(register) {
  const javascript = stripTypeScriptTypes(
    renderRegister(JSON.stringify(register)),
  );
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
  );
  return module.GENERATED_PRICING;
}

test("published exact cache-read prices reach actual token cost without changing write derivation", async () => {
  // Oracle: https://platform.claude.com/docs/en/about-claude/pricing,
  // verified 2026-09-08: Fable 5.1 standard $10/$50/$0.25; 5m writes $12.50.
  const register = structuredClone(valid);
  register.models[0].id = "claude-synthetic";
  register.models[0].standard = {
    inputUsdPerMTok: "10",
    outputUsdPerMTok: "50",
    cacheReadUsdPerMTok: "0.25",
  };
  const table = await generatedPricing(register);
  for (const [token, expected] of [
    ["inputTokens", 10],
    ["outputTokens", 50],
    ["cacheReadTokens", 0.25],
    ["cacheCreationTokens", 12.5],
  ]) {
    const usage = {
      models: {
        "claude-synthetic": {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          [token]: 1_000_000,
        },
      },
      skippedLines: 0,
    };
    const result = cost(usage, table);
    assert.equal(result.totalUsd, expected, token);
    assert.equal(result.hasUnknownModels, false);
  }
  delete register.models[0].standard.cacheReadUsdPerMTok;
  const defaultTable = await generatedPricing(register);
  assert.equal(defaultTable.rates["claude-synthetic"].cacheReadPerMTok, 1);
  assert.equal(
    defaultTable.rates["claude-synthetic"].cacheCreationPerMTok,
    12.5,
  );
});

test("standard and fast tiers independently accept exact reads or retain the default", async () => {
  for (const explicitTier of ["standard", "fast"]) {
    const register = structuredClone(valid);
    register.models[0].fast = { inputUsdPerMTok: "10", outputUsdPerMTok: "50" };
    register.models[0][explicitTier].cacheReadUsdPerMTok = "0.25";
    const table = await generatedPricing(register);
    assert.equal(
      table.rates["claude-opus-4-8"].cacheReadPerMTok,
      explicitTier === "standard" ? 0.25 : 0.5,
    );
    assert.equal(
      table.fastRates["claude-opus-4-8"].cacheReadPerMTok,
      explicitTier === "fast" ? 0.25 : 1,
    );
    assert.equal(table.fastRates["claude-opus-4-8"].cacheCreationPerMTok, 12.5);
  }
});

test("an explicit read need not satisfy the unused default's precision constraint", async () => {
  const register = structuredClone(valid);
  register.models[0].standard = {
    inputUsdPerMTok: "0.000004",
    outputUsdPerMTok: "1",
    cacheReadUsdPerMTok: "0.000001",
  };
  const table = await generatedPricing(register);
  assert.equal(table.rates["claude-opus-4-8"].cacheReadPerMTok, 0.000001);
  assert.equal(table.rates["claude-opus-4-8"].cacheCreationPerMTok, 0.000005);
});

test("invalid versions and exact-read contracts fail before any generated write", async () => {
  const root = await mkdtemp(join(tmpdir(), "pricing-exact-read-"));
  await mkdir(join(root, "pricing"));
  await mkdir(join(root, "src/generated"), { recursive: true });
  const output = join(root, "src/generated/pricing-register.ts");
  await writeFile(output, "sentinel\n");
  const invalid = [];
  for (const version of [1, 3, "2", null, 2.1]) {
    invalid.push({ ...structuredClone(valid), schemaVersion: version });
  }
  for (const tier of ["standard", "fast"]) {
    for (const decimal of [
      0.25,
      null,
      "0",
      "-1",
      "+1",
      "01",
      "1.0",
      "1e-1",
      "0.0000001",
      "9007199254.740992",
      "9007199254.740991",
    ]) {
      const register = structuredClone(valid);
      register.models[0][tier] = {
        inputUsdPerMTok: "5",
        outputUsdPerMTok: "25",
        cacheReadUsdPerMTok: decimal,
      };
      invalid.push(register);
    }
    for (const rates of [
      {
        inputUsdPerMTok: "5",
        cacheReadUsdPerMTok: "0.25",
        outputUsdPerMTok: "25",
      },
      {
        inputUsdPerMTok: "5",
        outputUsdPerMTok: "25",
        cacheReadUsdPerMTok: "0.25",
        cacheCreationUsdPerMTok: "6.25",
      },
      {
        inputUsdPerMTok: "0.000001",
        outputUsdPerMTok: "25",
        cacheReadUsdPerMTok: "0.25",
      },
      {
        inputUsdPerMTok: "9007199254.74098",
        outputUsdPerMTok: "25",
        cacheReadUsdPerMTok: "0.25",
      },
    ]) {
      const register = structuredClone(valid);
      register.models[0][tier] = rates;
      invalid.push(register);
    }
  }
  for (const register of invalid) {
    await writeFile(
      join(root, "pricing/models.json"),
      JSON.stringify(register),
    );
    for (const check of [false, true]) {
      await assert.rejects(generate(root, check), /invalid pricing register/);
      assert.equal(await readFile(output, "utf8"), "sentinel\n");
      assert.deepEqual(await readdir(join(root, "src/generated")), [
        "pricing-register.ts",
      ]);
    }
  }
});
