import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQualityCatalog } from "../src/quality-catalog.mjs";
import { createQualityRunner } from "../src/quality-runner.mjs";
import { implementationRun } from "./fixtures.mjs";

export const commandDefinition = (overrides = {}) => ({ id: "verify-fixture", image: `sha256:${"a".repeat(64)}`,
  argv: ["/usr/local/bin/node", "--test", "verify.test.mjs"], requiredGates: ["D", "E"],
  timeoutMs: 10000, outputLimitBytes: 8192, ...overrides });

test("catalog pins the entire host definition, returns detached bindings and rejects model-controlled fields", () => {
  const source = commandDefinition();
  const catalog = createQualityCatalog([source]);
  const binding = catalog.resolve([source.id])[0];
  source.argv.push("untrusted mutation");
  assert.equal(catalog.command(binding, "D").argv.length, 3);
  binding.requiredGates.length = 0;
  assert.deepEqual(catalog.bindings()[0].requiredGates, ["D", "E"]);
  assert.throws(() => catalog.command(binding, "D"), /BINDING_INVALID/);
  assert.throws(() => createQualityCatalog([commandDefinition({ shell: true })]));
  assert.throws(() => createQualityCatalog([commandDefinition({ image: "node:latest" })]));
  assert.throws(() => createQualityCatalog([commandDefinition(), commandDefinition()]), /DUPLICATE/);
  assert.throws(() => catalog.resolve(["unknown"]), /COMMAND_UNKNOWN/);
  assert.throws(() => catalog.resolve(["verify-fixture", "verify-fixture"]), /SELECTION_INVALID/);
});

test("changing argv, image, gate, time or output limits invalidates the frozen command", () => {
  const original = createQualityCatalog([commandDefinition()]);
  const binding = original.bindings()[0];
  for (const overrides of [{ argv: ["/bin/false"] }, { image: `sha256:${"b".repeat(64)}` },
    { requiredGates: ["D"] }, { timeoutMs: 20000 }, { outputLimitBytes: 4096 }]) {
    assert.throws(() => createQualityCatalog([commandDefinition(overrides)]).command(binding, "D"), /BINDING_INVALID/);
  }
  const onlyD = createQualityCatalog([commandDefinition({ requiredGates: ["D"] })]);
  assert.throws(() => onlyD.command(onlyD.bindings()[0], "E"), /BINDING_INVALID/);
});

test("quality execution rejects missing mandate, wrong run and phase before any OS execution", async () => {
  let validations = 0;
  const catalog = createQualityCatalog([commandDefinition()]);
  const runner = createQualityRunner({ dockerExecutable: join(tmpdir(), "nonexistent-docker"), scratchRoot: tmpdir(), workspace: tmpdir(),
    catalog, validateWorkspace: async () => { validations++; } });
  const run = implementationRun();
  for (const override of [{}, { runId: "wrong-run" }, { stage: "auditor", gate: "D" }, { cycle: 0 }]) {
    await assert.rejects(runner({ run, runId: run.runId, workerId: "worker", dispatchId: "dispatch", stage: "headsman", gate: "D", cycle: 1,
      binding: catalog.bindings()[0], ...override }, new AbortController().signal), /QUALITY_NOT_AUTHORIZED/);
  }
  assert.equal(validations, 0);
});
