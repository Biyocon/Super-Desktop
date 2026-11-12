import { gateOfStage, type ConductorStage } from "@pi-desktop/conductor-runtime/engine";
import type { ConductorProjection, ConductorReportView, ConductorWorker } from "@pi-desktop/shared";
import type { ConductorHost, LoadedConductorRun } from "./store.js";

type Receipt = { eventId: string; version: number; payloadHash: string; event: Record<string, unknown> };
function invalid(): never { throw new Error("CONDUCTOR_PROJECTION_INVALID"); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== "string" || !value) invalid(); return value; }
const roles = new Set<ConductorStage>(["detective", "strategist", "devils-advocate", "headsman", "auditor", "integrator", "arbiter", "ralph"]);
function stage(value: unknown): ConductorStage { if (!roles.has(value as ConductorStage)) invalid(); return value as ConductorStage; }

/** Bounded acknowledged prefix only; reading this ledger never dispatches or resumes. */
export async function readConductorEvents(host: ConductorHost, loaded: LoadedConductorRun): Promise<Receipt[]> {
  const receipts: Receipt[] = [], seen = new Map<string, Receipt>();
  const complete = () => { if (receipts.length !== loaded.index.eventCount) invalid(); return receipts; };
  let after = 0;
  for (let page = 0; page < 33; page++) {
    const response = object(await host.call("conductorStore.events", { sessionId: loaded.index.sessionId, runId: loaded.index.runId, after }));
    if (!Array.isArray(response.events) || response.events.length > 64) invalid();
    let last = after;
    for (const value of response.events) {
      const raw = object(value), version = Number(raw.version);
      if (!Number.isSafeInteger(version) || version < 1) invalid();
      if (version > loaded.index.version) return complete();
      const eventId = text(raw.eventId), payloadHash = text(raw.payloadHash);
      if (!/^[a-f0-9]{64}$/.test(payloadHash)) invalid();
      const event = object(object(raw.payload).event);
      if (event.runId !== loaded.index.runId) invalid();
      const receipt = { eventId, version, payloadHash, event };
      const previous = seen.get(eventId);
      if (previous) { if (previous.version !== version || previous.payloadHash !== payloadHash) invalid(); continue; }
      if (version <= last) invalid();
      last = version; seen.set(eventId, receipt); receipts.push(receipt);
      if (receipts.length > 2048) invalid();
    }
    if (!response.events.length || last >= loaded.index.version) return complete();
    if (last <= after) invalid();
    after = last;
  }
  invalid();
}

/** Presentation only. Every gate, report and next stage comes from the validated Harness record. */
export function projectConductor(loaded: LoadedConductorRun, receipts: Receipt[]): ConductorProjection {
  const run = loaded.checkpoint;
  const workers = new Map<string, ConductorWorker>();
  const diagnostics: ConductorProjection["diagnostics"] = [];
  for (const { event, version, payloadHash } of receipts) {
    if (event.runId !== run.runId || version > loaded.index.version) invalid();
    if (event.type === "runtime-error") { diagnostics.push({ version, code: text(event.code) }); continue; }
    if (!["dispatch-start", "dispatch-end", "worker-result"].includes(String(event.type))) continue;
    const dispatchId = text(event.dispatchId), workerId = text(event.workerId), role = stage(event.stage), mode = text(event.mode);
    const existing = workers.get(dispatchId);
    if (event.type === "dispatch-start") {
      if (existing) { if (existing.workerId !== workerId || existing.inputHash !== payloadHash) invalid(); continue; }
      workers.set(dispatchId, { dispatchId, workerId, stage: role, mode, task: run.objective, startVersion: version, inputHash: payloadHash, status: "running" });
      continue;
    }
    if (!existing || existing.workerId !== workerId || existing.stage !== role || existing.mode !== mode) invalid();
    if (event.type === "worker-result") { if (typeof event.modelId === "string") existing.modelId = event.modelId; continue; }
    if (event.status !== "completed" && event.status !== "failed" && event.status !== "cancelled") invalid();
    const output = event.response === undefined ? undefined : JSON.stringify(event.response, null, 2);
    if (existing.endVersion !== undefined) { if (existing.status !== event.status || existing.output !== output) invalid(); continue; }
    existing.status = event.status; existing.endVersion = version;
    if (output !== undefined) existing.output = output;
    if (typeof event.error === "string") existing.error = event.error;
  }
  if (loaded.index.status !== "running" && loaded.index.status !== "owner-waiting") {
    for (const worker of workers.values()) if (worker.status === "running") worker.status = "interrupted";
  }
  const reports: ConductorReportView[] = [];
  const add = (kind: ConductorReportView["kind"], role: ConductorStage, body: unknown) => reports.push({ id: `${kind}-${reports.length}`, kind, stage: role, body: JSON.stringify(body, null, 2) });
  for (const report of run.specialistReports) add("specialist", stage(report.stage), report);
  for (const report of run.analysisReports) add("analysis", report.stage, report);
  for (const report of run.reportCandidates) add("candidate", report.producer, report);
  for (const challenge of run.analysisChallenges) add("challenge", "devils-advocate", challenge);
  for (const evidence of run.qualityExecutions) add("quality", evidence.executorStage, evidence);
  if (run.decision) add("decision", "arbiter", run.decision);
  if (run.reportDecision) add("decision", "arbiter", run.reportDecision);
  for (const interaction of run.ownerLedger) add("owner", "intake", interaction);
  const next = loaded.index.status === "interrupted" && run.status === "running" ? "validate-resume"
    : run.status === "awaiting_authorization" ? "external-authorization"
    : loaded.index.status === "owner-waiting" || ["awaiting_owner", "continuation_pending", "rework", "escalated"].includes(run.status) ? "owner"
    : loaded.index.status === "running" && run.status === "running" ? "motor-stage" : "none";
  // Format 5 retains valid NO-GO in the authoritative Gate-G record, not run.decision.
  const noGo = [...run.history].reverse().find(gate => gate.kind === "evaluated" && gate.gate === "G" && gate.stage === "arbiter" && gate.decision === "escalate" && gate.stateUpdate === "arbiter NO-GO — escalate to owner");
  return {
    recordFormat: run.recordFormatVersion, purpose: run.admission.purpose, objective: run.objective,
    motorStatus: run.status, currentStage: run.currentStage, currentGate: gateOfStage(run.currentStage),
    authorityOwner: run.authority.owner, sourceBaseline: run.sourceBaseline,
    ...(run.decision ? { arbiterDecision: { purpose: "implementation" as const, outcome: run.decision.decision, basis: [...run.decision.basis], evidenceReviewed: [...run.decision.evidence_reviewed] } }
      : run.reportDecision ? { arbiterDecision: { purpose: "analysis" as const, outcome: run.reportDecision.decision, basis: [...run.reportDecision.basis], evidenceReviewed: [...run.reportDecision.evidence_reviewed] } }
      : noGo ? { arbiterDecision: { purpose: "implementation" as const, outcome: "no-go" as const, basis: [...noGo.basis], evidenceReviewed: [...noGo.evidenceReviewed] } } : {}),
    scope: [...run.scope], allowedPaths: [...run.allowedPaths], excludedPaths: [...run.excludedPaths], acceptanceCriteria: [...run.acceptanceCriteria], constraints: [...run.constraints], next,
    gateHistory: run.history.map((gate, index) => ({ index, gate: gate.gate, stage: gate.stage, kind: gate.kind, decision: gate.decision,
      basis: [...gate.basis], evidenceReviewed: [...gate.evidenceReviewed], stateUpdate: gate.stateUpdate, nextStage: gate.nextStage,
      defectClass: gate.defectClass, executionBaselineHash: gate.executionBaselineHash })),
    workers: [...workers.values()], reports, diagnostics,
  };
}
