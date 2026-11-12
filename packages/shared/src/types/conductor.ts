/** Dedicated Conductor UI boundary; no credentials, executable paths or model tools. */
export type ConductorPurpose = "analysis" | "implementation";
export type ConductorEntry = {
  requestId: string;
  sessionId: string;
  objective: string;
  purpose: ConductorPurpose;
  scope: string[];
  allowedPaths: string[];
  excludedPaths: string[];
  acceptanceCriteria: string[];
  materialPaths: string[];
  qualityCommandIds: string[];
};
export type ConductorRunRef = { sessionId: string; runId: string };
export type ConductorResume = ConductorRunRef & { expectedVersion: number };
export type ConductorConsentAnswer = ConductorRunRef & {
  requestId: string; baselineHash: string; approve: boolean;
};
export type ConductorQualityCommand = {
  id: string; image: string; argv: string[]; requiredGates: Array<"D" | "E">;
  timeoutMs: number; outputLimitBytes: number;
};
export type ConductorProvenance = {
  revision: string; version: string; license: "MIT"; recordFormat: 5;
  artifacts: Record<string, string>;
};
export type ConductorAvailability =
  | { available: true; provenance: ConductorProvenance }
  | { available: false; code: string };
export type ConductorLifecycle = "running" | "owner-waiting" | "interrupted" | "completed" | "failed" | "cancelled";
export type ConductorIndex = ConductorRunRef & {
  schema: 1; projectPath: string; version: number; eventCount: number;
  requestId?: string | null;
  status: ConductorLifecycle; checkpointHash: string; runtimeId: string;
};
export type ConductorConsentRequest = ConductorRunRef & {
  requestId: string; baselineHash: string; sourceFingerprint: string;
  baseline: {
    scopeVersion: string; planVersion: string; acceptanceVersion: string;
    allowedPaths: string[]; excludedPaths: string[]; rollbackReference: string;
    qualityCommands: Array<{ id: string; definitionHash: string; requiredGates: Array<"D" | "E"> }>;
  };
  effectProfile: { filesystem: "read-only" | "workspace-write"; quality: "none" | "catalog"; external: "none" };
};
/** Opaque format-5 motor document, not a renderer-owned gate state machine. */
export type ConductorHistory = {
  index: ConductorIndex;
  checkpoint: unknown;
  intake: unknown;
  resourceIssues: Array<{ resourceId: string; code: "CONDUCTOR_CONTAINER_CLEANUP_FAILED"; creationUncertain: boolean }>;
  projection?: ConductorProjection;
  pendingConsent?: ConductorConsentRequest | null;
};
/** Invalidations only: readers reload authoritative history; events never advance gates. */
export type ConductorChanged = ConductorRunRef;
export type ConductorFault = ConductorRunRef & { code: string };

export type ConductorStage = "intake" | "detective" | "strategist" | "devils-advocate" | "headsman" | "ralph" | "auditor" | "integrator" | "arbiter" | "closeout" | "report-complete";
export type ConductorGate = "A" | "B" | "C" | "D" | "E" | "F" | "G";
export type ConductorWorker = {
  dispatchId: string; workerId: string; stage: ConductorStage; mode: string;
  task: string; startVersion: number; inputHash: string; endVersion?: number;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  modelId?: string; output?: string; error?: string;
};
export type ConductorGateView = {
  index: number; gate: ConductorGate; stage: ConductorStage;
  kind: "evaluated" | "skipped"; decision: "pass" | "rework" | "escalate" | "abort" | "skipped";
  basis: string[]; evidenceReviewed: string[]; stateUpdate: string;
  nextStage?: ConductorStage; defectClass?: string; executionBaselineHash?: string;
};
export type ConductorReportView = {
  id: string; stage: ConductorStage;
  kind: "specialist" | "analysis" | "candidate" | "challenge" | "decision" | "quality" | "owner";
  body: string;
};
/** Read-only projection of the exact acknowledged motor checkpoint and journal prefix. */
export type ConductorProjection = {
  recordFormat: 5; purpose: ConductorPurpose; objective: string;
  motorStatus: string; currentStage: ConductorStage; currentGate?: ConductorGate;
  authorityOwner: string; sourceBaseline: string | null;
  scope: string[]; allowedPaths: string[]; excludedPaths: string[]; acceptanceCriteria: string[]; constraints: string[];
  next: "motor-stage" | "owner" | "validate-resume" | "external-authorization" | "none";
  arbiterDecision?: { purpose: ConductorPurpose; outcome: "go" | "no-go" | "accept" | "revise" | "blocked"; basis: string[]; evidenceReviewed: string[] };
  gateHistory: ConductorGateView[]; workers: ConductorWorker[]; reports: ConductorReportView[];
  diagnostics: Array<{ version: number; code: string }>;
};
