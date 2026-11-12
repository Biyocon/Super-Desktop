import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createDispatcher, captureMandate, createQualityCatalog, createQualityRunner } from "@pi-desktop/conductor-runtime/adapter";
import { drive, executionBaselineHash } from "@pi-desktop/conductor-runtime/engine";
import { implementationRun, envelope, dispatcher } from "./fixtures.mjs";

test("public built package uses the pinned shared engine and retains bundled MIT notices", async () => {
  for (const entry of [createDispatcher, captureMandate, createQualityCatalog, createQualityRunner]) assert.equal(typeof entry, "function");
  const provenance = JSON.parse(readFileSync(new URL("../dist/provenance.json", import.meta.url), "utf8"));
  assert.equal(provenance.revision, "879ab27bdd22203675d6f0cc678652779fc089cd");
  assert.equal(provenance.packageVersion, "0.1.0-rc.7");
  for (const [name, hash] of Object.entries(provenance.artifacts)) {
    assert.equal(createHash("sha256").update(readFileSync(new URL(`../dist/${name}`, import.meta.url))).digest("hex"), hash);
  }
  assert.match(readFileSync(new URL("../dist/HARNESS-LICENSE", import.meta.url), "utf8"), /MIT License/);
  assert.match(readFileSync(new URL("../dist/ZOD-LICENSE", import.meta.url), "utf8"), /MIT License/);
  const events = [];
  const host = { journal: async event => { events.push(event); }, validateWorkspace: async () => {}, countTokens: text => text.length,
    executeTool: async () => { throw new Error("No tool action in public package contract fixture"); },
    runQuality: async () => { throw new Error("No quality command admitted in public package contract fixture"); },
    resolveBaseline: async (_run, baseline) => baseline,
    authorizeExecution: async (_run, baseline, effectProfile) => ({ executionBaselineHash: executionBaselineHash(baseline), effectProfile }) };
  const provider = { dispatch: request => request.stage === "arbiter"
    ? dispatcher().dispatchArbiter(request.run) : envelope(request.stage, request.run) };
  const result = await drive(implementationRun(), createDispatcher({ host, provider, workspace: "unused", signal: new AbortController().signal }));
  assert.equal(result.run.status, "awaiting_authorization");
  assert.deepEqual(result.run.history.map(item => item.gate), ["A", "B", "C", "D", "E", "F", "G"]);
  assert.equal(events.filter(event => event.type === "dispatch-start").length, 7);
});
