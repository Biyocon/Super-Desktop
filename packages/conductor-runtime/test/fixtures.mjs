import { admitIntake, captureIntakeMaterial, ConductorRunId, createRun, executionBaselineHash } from "../dist/engine.mjs";

export function implementationRun(overrides = {}, runId = "CON-2026-9001") {
  return createRun(ConductorRunId(runId), {
    admission: admitIntake({ purpose: "implementation", entry: "detective", rationale: "Owned local contract fixture." }, [
      captureIntakeMaterial("current-request", "Verify this owned fixture only.", { sessionId: "fixture-parent", eventIndex: 0 }),
    ]),
    objective: "Verify the authoritative driver.", authority: { owner: "fixture-user" },
    scope: ["owned fixture"], allowedPaths: ["fixture.txt"], excludedPaths: [],
    acceptanceCriteria: ["Harness evaluates each required stage."],
    budget: { maxReworkPerGate: 2, maxRalphRounds: 0, maxOwnerReassessmentsPerGate: 2,
      maxCriticInputTokensPerAttempt: 24000, maxCriticOutputTokensPerAttempt: 16000, maxCriticTokensPerRun: 120000 },
    ...overrides,
  });
}

// These outputs exercise motor contracts; they are not evidence of an implemented change.
export function envelope(stage, run) {
  return {
    run_id: run.runId, stage, baseline_ref: "fixture-source-v1",
    ...(stage === "detective" ? { source_baseline: "fixture-source-v1" } : {}),
    status: "ready", summary: `Local ${stage} fixture output.`,
    evidence: [{ kind: "test", reference: "fixture-output-contract", outcome: "Motor contract only." }],
    findings: [], assumptions: [], blockers: [], artifacts: [], change_requests: [], quality_evidence_ids: [],
    recommended_transition: { target: "conductor", rationale: "Motor evaluates the output." }, confidence: "high",
    ...(stage === "devils-advocate" ? { execution_baseline: {
      scopeVersion: "scope-1", planVersion: "plan-1", acceptanceVersion: "accept-1", allowedPaths: run.allowedPaths,
      excludedPaths: run.excludedPaths, rollbackReference: "fixture-source-v1", qualityCommands: [],
    } } : {}),
  };
}

export function dispatcher(overrides = {}) {
  return {
    authorizeExecution: async (_run, baseline, effectProfile) => ({ executionBaselineHash: executionBaselineHash(baseline), effectProfile }),
    dispatchSpecialist: async (stage, run) => envelope(stage, run),
    dispatchArbiter: async run => ({ run_id: run.runId, decision: "go", basis: ["Motor fixture."],
      evidence_reviewed: ["fixture-output-contract"], conditions: [], open_risks: [], required_follow_up: [] }),
    ...overrides,
  };
}
