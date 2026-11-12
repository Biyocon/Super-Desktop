import assert from "node:assert/strict";
import { test } from "node:test";
import { drive, parseRun, serializeRun } from "../dist/engine.mjs";
import { dispatcher, envelope, implementationRun } from "./fixtures.mjs";

// Provider boundary reports only. The unchanged driver routes and invalidates.
for (const defect of ["plan", "implementation"]) test(`actual driver routes ${defect} audit rework and preserves its evidence/authorization semantics`, async () => {
  const calls = [], checkpoints = [], approvals = [];
  let firstAudit = true;
  const result = await drive(implementationRun(), dispatcher({
    authorizeExecution: async (run, baseline, effects) => {
      approvals.push({ historyLength: run.history.length, baseline: structuredClone(baseline) });
      return dispatcher().authorizeExecution(run, baseline, effects);
    },
    dispatchSpecialist: async (stage, run) => {
      calls.push(stage);
      const report = envelope(stage, run);
      if (stage === "auditor" && firstAudit) {
        firstAudit = false; report.status = "rework";
        report.summary = `Owned fixture ${defect} defect needs correction`;
        if (defect === "plan") report.change_requests = [{ target: "plan", reason: "Design does not meet the acceptance criteria", impact: "Revisit plan and challenge before implementation" }];
      }
      return report;
    },
  }), async run => checkpoints.push(parseRun(serializeRun(run))));
  assert.equal(result.kind, "decision");
  const rework = result.run.history.find(gate => gate.gate === "E" && gate.decision === "rework");
  assert.ok(rework); assert.equal(rework.defectClass, defect);
  assert.ok(rework.basis.includes(`Owned fixture ${defect} defect needs correction`));
  assert.ok(rework.evidenceReviewed.includes("fixture-output-contract"));
  const captured = checkpoints.find(run => run.history.at(-1)?.gate === "E" && run.history.at(-1).decision === "rework");
  assert.ok(captured);
  if (defect === "plan") {
    assert.equal(rework.nextStage, "strategist");
    assert.equal(captured.baseline, null); assert.equal(captured.executionAuthorization, null);
    assert.equal(approvals.length, 2, "Design rework must obtain fresh Gate-C authorization");
    assert.deepEqual(calls.slice(calls.indexOf("auditor") + 1), ["strategist", "devils-advocate", "headsman", "auditor", "integrator"]);
  } else {
    assert.equal(rework.nextStage, "headsman");
    assert.ok(captured.baseline); assert.ok(captured.executionAuthorization);
    assert.equal(approvals.length, 1, "Implementation repair remains within the unchanged authorized baseline");
    assert.deepEqual(calls.slice(calls.indexOf("auditor") + 1), ["headsman", "auditor", "integrator"]);
  }
  assert.equal(result.run.status, "awaiting_authorization");
  assert.deepEqual(parseRun(serializeRun(result.run)), result.run);
});

test("valid Arbiter NO-GO is an engine outcome, never GO or external permission", async () => {
  const result = await drive(implementationRun(), dispatcher({ dispatchArbiter: async run => ({ run_id: run.runId, decision: "no-go", basis: ["Unresolved owned fixture risk"],
    evidence_reviewed: ["fixture-output-contract"], conditions: [], open_risks: ["Owned risk remains"], required_follow_up: ["Owner must decide next steps"] }) }));
  assert.equal(result.run.decision, undefined, "Pinned motor retains NO-GO in its authoritative Gate-G record");
  assert.equal(result.kind, "blocked");
  assert.equal(result.run.status, "escalated");
  assert.equal(result.run.history.at(-1).stateUpdate, "arbiter NO-GO — escalate to owner");
  assert.notEqual(result.run.status, "awaiting_authorization");
  assert.equal(result.run.history.at(-1).gate, "G");
  assert.notEqual(result.run.history.at(-1).decision, "pass");
  assert.deepEqual(parseRun(serializeRun(result.run)), result.run);
});
