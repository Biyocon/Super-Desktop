import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { admitIntake, captureIntakeMaterial, drive, currentAuditHash, serializeRun, parseRun } from "../dist/engine.mjs";
import { createDispatcher } from "../src/dispatcher.mjs";
import { implementationRun } from "./fixtures.mjs";

async function analysisFixture({ changeCritic = value => value, countTokens = text => Buffer.byteLength(text), budget } = {}) {
  const root = mkdtempSync(join(tmpdir(), "conductor-analysis-"));
  const events = [], requests = [];
  let versions = 0;
  try {
    writeFileSync(join(root, "source.txt"), "Owned source is unchanged.\n");
    const material = captureIntakeMaterial("source.txt", readFileSync(join(root, "source.txt"), "utf8"));
    const ownerRequest = captureIntakeMaterial("current-request", "Assess source.txt without mutation.", { sessionId: "fixture-parent", eventIndex: 0 });
    const admission = admitIntake({ purpose: "analysis", entry: "detective", deliverable: "answer", rationale: "Read-only source fixture." }, [ownerRequest, material]);
    const run = implementationRun({ admission, allowedPaths: [], excludedPaths: [], ...(budget ? { budget } : {}) });
    const host = {
      validateWorkspace: async () => {}, countTokens, journal: async event => { events.push(event); },
      authorizeExecution: async () => { throw new Error("analysis must not request approval"); },
      resolveBaseline: async () => { throw new Error("analysis must not resolve an execution baseline"); },
      runQuality: async () => { throw new Error("analysis must not execute a command"); },
      executeTool: async request => {
        assert.equal(request.name, "read"); assert.equal(request.arguments.file_path, "source.txt");
        return readFileSync(join(root, "source.txt"), "utf8");
      },
    };
    const provider = { dispatch: async request => {
      requests.push({ stage: request.stage, mode: request.mode, workerId: request.workerId });
      await assert.rejects(request.executeTool("write", { file_path: "source.txt", content: "denied" }), /TOOL_DENIED/);
      assert.equal(await request.executeTool("read", { file_path: "source.txt" }), material.content);
      if (request.mode === "critic") {
        assert.equal(request.run, undefined, "critic receives independently bound prompt, not producer history");
        assert.ok(request.maxOutputTokens > 0);
        const prompt = JSON.parse(request.input.prompt);
        const response = { value: { ...prompt.identity, purpose: "analysis", findings: [], conclusion: "holds", summary: "The cited source supports this bounded answer." },
          inputTokens: request.input.tokenCount, outputTokens: 20 };
        return changeCritic(response, request);
      }
      const current = request.run;
      if (request.stage === "arbiter") return { run_id: current.runId, purpose: "analysis", candidate_hash: current.reportCandidates.at(-1).hash,
        challenge_hash: current.analysisChallenges.at(-1).hash, audit_hash: currentAuditHash(current), decision: "accept",
        basis: ["Candidate, independent challenge and audit agree."], evidence_reviewed: [material.id], open_risks: [] };
      const envelope = { run_id: current.runId, purpose: "analysis", stage: request.stage, deliverable: "answer", status: "ready",
        summary: "Owned source assessed without mutation.", material_ids: [material.id], blockers: [], assumptions: [], limitations: [] };
      if (request.stage === "detective") envelope.candidate = { version: `v${++versions}`, deliverable: "answer", content: material.content.trim(),
        criteria: current.acceptanceCriteria.map(criterion => ({ criterion, outcome: "Source read and evaluated." })), material_ids: [material.id],
        material_spans: [{ material_id: material.id, start_line: 1, end_line: 1 }], assumptions: [], limitations: [] };
      if (request.stage === "auditor") envelope.candidate_hash = current.reportCandidates.at(-1).hash;
      return envelope;
    } };
    const result = await drive(run, createDispatcher({ host, provider, workspace: root, signal: new AbortController().signal }),
      async checkpoint => { parseRun(serializeRun(checkpoint)); });
    assert.equal(readFileSync(join(root, "source.txt"), "utf8"), material.content);
    return { result, events, requests };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("actual analysis driver binds producer/critic/audit/verdict and explicitly skips execution gates", async () => {
  const { result, events, requests } = await analysisFixture();
  assert.equal(result.kind, "report"); assert.equal(result.run.status, "reported");
  assert.equal(result.run.decision, undefined); assert.equal(result.run.executionAuthorization, null);
  assert.deepEqual(requests.map(item => item.stage), ["detective", "devils-advocate", "auditor", "arbiter"]);
  assert.equal(new Set(requests.map(item => item.workerId)).size, 4);
  assert.deepEqual(result.run.history.filter(item => item.kind === "skipped").map(item => item.gate), ["B", "D", "F"]);
  assert.ok(result.run.history.filter(item => item.kind === "skipped").every(item => item.basis.length > 0));
  assert.notEqual(result.run.reportCandidates[0].producerChildId, result.run.analysisChallenges[0].criticChildId);
  const start = events.find(event => event.mode === "critic" && event.type === "dispatch-start");
  assert.equal(JSON.parse(start.input.prompt).identity.critic_child_id, result.run.analysisChallenges[0].criticChildId);
});

test("stale critic candidate blocks the run instead of accepting model prose", async () => {
  const { result, requests } = await analysisFixture({ changeCritic: response => ({ ...response, value: { ...response.value, candidate_hash: "0".repeat(64) } }) });
  assert.equal(result.kind, "blocked"); assert.equal(result.run.status, "escalated");
  assert.equal(result.run.analysisChallenges.length, 0); assert.ok(!requests.some(item => item.stage === "auditor"));
});

test("missing critic usage blocks rather than fabricating zero cost", async () => {
  const { result } = await analysisFixture({ changeCritic: response => ({ value: response.value }) });
  assert.equal(result.kind, "blocked"); assert.match(result.blocker, /USAGE_MISSING/);
  assert.equal(result.run.analysisChallenges.length, 0);
});

test("oversized exact critic input blocks before provider dispatch without truncation", async () => {
  const { result, requests } = await analysisFixture({ countTokens: () => 25000 });
  assert.equal(result.kind, "blocked"); assert.match(result.blocker, /input exceeds token limit/);
  assert.equal(requests.filter(item => item.mode === "critic").length, 0);
  assert.equal(result.run.history.at(-1).origin, "critic-budget");
});

test("cumulative critic reservation survives rework and prevents another provider attempt", async () => {
  const budget = { maxReworkPerGate: 2, maxRalphRounds: 0, maxOwnerReassessmentsPerGate: 2,
    maxCriticInputTokensPerAttempt: 24000, maxCriticOutputTokensPerAttempt: 16000, maxCriticTokensPerRun: 40000 };
  const { result, requests } = await analysisFixture({ budget, countTokens: () => 20000, changeCritic: response => ({
    value: { ...response.value, conclusion: "does_not_hold", defect: "report", findings: [{ id: "missing-detail", severity: "major",
      claim: "Candidate needs a more explicit conclusion.", rationale: "Fixture forces a fresh producer revision.", material_ids: response.value.material_ids }] },
    inputTokens: 23000, outputTokens: 15000,
  }) });
  assert.equal(result.kind, "blocked"); assert.match(result.blocker, /RUN_BUDGET_EXHAUSTED/);
  assert.equal(requests.filter(item => item.mode === "critic").length, 1);
  assert.equal(result.run.reportCandidates.length, 2);
  assert.ok(result.run.history.some(item => item.decision === "rework"));
});
