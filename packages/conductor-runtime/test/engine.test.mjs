import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  drive, parseRun, serializeRun, executionBaselineHash, toolGuardForStage,
  analysisToolGuard, toolRestrictionForStage, CONDUCTOR_RECORD_FORMAT_VERSION,
} from "../dist/engine.mjs";
import { implementationRun, dispatcher, envelope } from "./fixtures.mjs";

test("actual pinned driver evaluates A-G and does not turn GO into release authority", async () => {
  const called = [], checkpoints = [];
  const result = await drive(implementationRun(), dispatcher({ dispatchSpecialist: async (stage, run) => {
    called.push(stage); return envelope(stage, run);
  } }), async run => checkpoints.push(parseRun(serializeRun(run))));
  assert.equal(CONDUCTOR_RECORD_FORMAT_VERSION, 5);
  assert.deepEqual(called, ["detective", "strategist", "devils-advocate", "headsman", "auditor", "integrator"]);
  assert.deepEqual(result.run.history.filter(gate => gate.kind === "evaluated").map(gate => gate.gate), ["A", "B", "C", "D", "E", "F", "G"]);
  assert.equal(result.kind, "decision");
  assert.equal(result.run.status, "awaiting_authorization");
  assert.ok(checkpoints.length >= 7);
  assert.deepEqual(parseRun(serializeRun(result.run)), result.run);
});

for (const [name, corrupt] of [
  ["wrong run", reply => ({ ...reply, run_id: "CON-2026-9999" })],
  ["phase hop", reply => ({ ...reply, stage: "headsman" })],
  ["missing evidence", reply => ({ ...reply, evidence: [] })],
]) test(`driver refuses ${name} without dispatching the next stage`, async () => {
  const called = [];
  const result = await drive(implementationRun(), dispatcher({ dispatchSpecialist: async (stage, run) => {
    called.push(stage); return corrupt(envelope(stage, run));
  } }));
  assert.equal(result.kind, "blocked");
  assert.ok(called.length > 0);
  assert.ok(called.every(stage => stage === "detective"));
  assert.equal(result.run.history.some(gate => gate.gate === "A" && gate.decision === "pass"), false);
});

for (const approval of [null, { executionBaselineHash: "wrong-baseline", effectProfile: { filesystem: "workspace-write", quality: "none", external: "none" } }]) {
  test(`driver blocks Headsman when approval is ${approval === null ? "missing" : "stale"}`, async () => {
    const called = [];
    const result = await drive(implementationRun(), dispatcher({
      authorizeExecution: async () => approval,
      dispatchSpecialist: async (stage, run) => { called.push(stage); return envelope(stage, run); },
    }));
    assert.equal(result.kind, "blocked");
    assert.equal(called.includes("headsman"), false);
    assert.equal(result.run.executionAuthorization, null);
  });
}

test("malformed Arbiter GO is not accepted", async () => {
  const result = await drive(implementationRun(), dispatcher({ dispatchArbiter: async () => ({ decision: "go" }) }));
  assert.equal(result.kind, "blocked");
  assert.notEqual(result.run.status, "awaiting_authorization");
});

test("analysis execution guard denies writes, commands and external tools", () => {
  for (const name of ["write", "edit", "bash", "commit", "Task", "browser", "approval"]) assert.equal(typeof analysisToolGuard({ name, arguments: {} }), "string");
  assert.equal(analysisToolGuard({ name: "read", arguments: {} }), undefined);
  assert.deepEqual(toolRestrictionForStage("auditor", null).allow, ["read", "read_image", "grep", "glob"]);
});

test("upstream argument guard confines authorized writes and keeps Git metadata read-only", () => {
  const root = mkdtempSync(join(tmpdir(), "conductor-guard-"));
  try {
    mkdirSync(join(root, "owned")); mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "owned", "fixture.txt"), "owned");
    const baseline = { scopeVersion: "scope-1", planVersion: "plan-1", acceptanceVersion: "accept-1",
      allowedPaths: [join(root, "owned")], excludedPaths: [], rollbackReference: "source-v1", qualityCommands: [] };
    const authorization = { executionBaselineHash: executionBaselineHash(baseline), effectProfile: { filesystem: "workspace-write", quality: "none", external: "none" } };
    const attempt = file_path => ({ name: "write", arguments: { file_path }, agent: { session: { header: { cwd: root } } } });
    const guard = toolGuardForStage("headsman", baseline, authorization);
    assert.equal(guard(attempt("owned/fixture.txt")), undefined);
    assert.equal(typeof guard(attempt("outside/fixture.txt")), "string");
    assert.equal(typeof guard(attempt("owned/.git/config")), "string");
    assert.equal(typeof toolGuardForStage("headsman", baseline, null)(attempt("owned/fixture.txt")), "string");
    assert.equal(typeof toolGuardForStage("integrator", baseline, authorization)(attempt("owned/fixture.txt")), "string");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
