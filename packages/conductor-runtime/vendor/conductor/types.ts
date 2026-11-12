/**
 * Conductor run and gate vocabulary: the durable run record, the stage and
 * gate decision types, and the two wire records a specialist returns (the
 * {@link SpecialistEnvelope} and the Arbiter's {@link DecisionRecord}).
 *
 * Internal run state is camelCase; the specialist wire records stay snake_case
 * because they match the YAML the model writes (see the `conductor-specialist`
 * and `conductor-closeout` skills). Types only, plus the id-brand factory, per
 * the package convention.
 *
 * @module @deepseek-ai/dsh-conductor/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OwnerInteraction, OwnerMandate, OwnerMandateProposal, OwnerQuestionItem } from './owner-types.ts'
import type { AnalysisChallenge } from './analysis-challenge.ts'
import type { AnalysisMaterialSpan } from './analysis-materials.ts'

/**
 * Identifies one Conductor run. The runtime mints `CON-YYYY-NNNN`; every
 * specialist dispatch, gate record, and the closeout record key off this id.
 */
export type ConductorRunId = Branded<'ConductorRunId'>

/**
 * Brand a string as a {@link ConductorRunId}.
 * @param id - the raw run-id string (`CON-YYYY-NNNN`).
 * @returns the same string, branded; no validation is performed.
 */
export function ConductorRunId(id: string): ConductorRunId {
  return id as ConductorRunId
}

/**
 * Where a run is in its lifecycle. The seven gated stages — `detective`
 * through `arbiter` — each map to exactly one gate (A through G). The
 * remaining values are not gates: `intake` precedes Gate A, `closeout` follows
 * Gate G, and `ralph` is a Headsman-internal iteration sub-phase that never
 * owns a gate.
 */
export type ConductorStage =
  | 'intake'
  | 'detective'
  | 'strategist'
  | 'devils-advocate'
  | 'headsman'
  | 'ralph'
  | 'auditor'
  | 'integrator'
  | 'arbiter'
  | 'closeout'
  | 'report-complete'

/** Intake stages supported before execution authorization. */
export type ConductorEntry = 'detective' | 'strategist' | 'devils-advocate'

/** Analysis result requested by the owner. */
export type ReportDeliverable = 'answer' | 'recommendations'

/** Runtime-minted identity of one captured intake input. */
export type ConductorMaterialId = Branded<'ConductorMaterialId'>

/** Captured input whose bytes and provenance survive resume. */
export interface IntakeMaterial {
  id: ConductorMaterialId
  selector: string
  kind: 'current-request' | 'file'
  content: string
  sha256: string
  sourceMessage?: { sessionId: SessionId; eventIndex: number }
}

/** Required purpose and deliverable combinations; entry never grants authority. */
export type IntakeSelection =
  | { purpose: 'implementation'; entry: ConductorEntry; deliverable?: never }
  | { purpose: 'analysis'; entry: ConductorEntry; deliverable: ReportDeliverable }

/** Immutable admitted inputs and runtime-selected workflow profile. */
export type ConductorAdmission = IntakeSelection & {
  profileVersion: 1
  rationale: string
  materials: [IntakeMaterial, ...IntakeMaterial[]]
  scopeSources: ConductorMaterialId[]
  plan: string[]
  planSources: ConductorMaterialId[]
}

/** Causal return after an earlier stage repairs a gate's missing prerequisite. */
export interface RepairReturn {
  stage: ConductorStage
  returnTo: ConductorStage
}

/** A producer's read-only answer or recommendations, independently audited before completion. */
export interface ReportCandidate {
  version: string
  deliverable: ReportDeliverable
  content: string
  criteria: { criterion: string; outcome: string }[]
  material_ids: string[]
  /** Exact admitted text ranges selected by runtime for the critic. */
  material_spans: AnalysisMaterialSpan[]
  assumptions: string[]
  limitations: string[]
}

/** Runtime-owned version/hash linking a producer's report to its audit. */
export interface CapturedReport {
  producer: ConductorEntry
  candidate: ReportCandidate
  hash: string
  /** Fresh child that authored this candidate, distinct from its critic. */
  producerChildId: SessionId
}

/** One validated critique with its exact candidate and measured model cost. */
export interface CapturedAnalysisChallenge {
  challenge: AnalysisChallenge
  hash: string
  candidateHash: string
  criticChildId: SessionId
  criticAttempt: number
  inputTokens: number
  outputTokens: number
}

/** Analysis-specific specialist output; no execution baseline or command evidence. */
export interface AnalysisEnvelope {
  run_id: string
  purpose: 'analysis'
  stage: ConductorEntry | 'auditor'
  deliverable: ReportDeliverable
  status: SpecialistStatus
  summary: string
  material_ids: string[]
  blockers: string[]
  assumptions: string[]
  limitations: string[]
  /** `analysis` requests a new producer candidate and is valid only for Auditor rework. */
  defect?: 'scope' | 'plan' | 'report' | 'analysis'
  candidate?: ReportCandidate
  candidate_hash?: string
  /** Read-only owner clarification; it cannot request implementation authority. */
  clarifications?: OwnerQuestionItem[]
}

/** Independent report verdict, never a release decision or an authorization. */
export interface ReportDecision {
  run_id: string
  purpose: 'analysis'
  candidate_hash: string
  audit_hash: string
  challenge_hash: string
  decision: 'accept' | 'revise' | 'blocked'
  basis: string[]
  evidence_reviewed: string[]
  open_risks: string[]
}

/** An external action that may be recorded during owner-authorized closeout. */
export type ConductorAction = 'read' | 'write' | 'commit' | 'push' | 'merge' | 'release' | 'publish' | 'deploy'

/** Attribution for the mandate; execution authorization is host-owned and separate. */
export interface ConductorAuthority {
  /** The mandate owner: a human, the initiating agent ('emperor'), or another named owner. */
  owner: string
}

/** Host-approved effects for one immutable execution baseline. */
export interface ExecutionEffectProfile {
  /** Maximum filesystem effect granted to specialists under the baseline. */
  filesystem: 'read-only' | 'workspace-write'
  /** Whether deployment-owned quality commands may execute. */
  quality: 'none' | 'catalog'
  /** External effects are never part of Conductor execution authorization. */
  external: 'none'
}

/** Durable host authorization bound to one exact Gate-C baseline. */
export interface ExecutionAuthorization {
  /** SHA-256 of the baseline the host approved. */
  executionBaselineHash: string
  /** Exact effects approved for that baseline. */
  effectProfile: ExecutionEffectProfile
}

/** Stable deployment-owned quality-command identity. */
export type QualityCommandId = Branded<'QualityCommandId'>

/**
 * Brand a validated quality-command id.
 * @param id - deployment-owned normalized command id.
 * @returns the branded command identity.
 */
export function QualityCommandId(id: string): QualityCommandId {
  return id as QualityCommandId
}

/** Stable host-owned evidence identity for one quality execution. */
export type QualityEvidenceId = Branded<'QualityEvidenceId'>

/**
 * Brand a minted quality-evidence id.
 * @param id - host-minted evidence identity.
 * @returns the branded evidence identity.
 */
export function QualityEvidenceId(id: string): QualityEvidenceId {
  return id as QualityEvidenceId
}

/** A Gate-C binding to one immutable deployment command definition. */
export interface QualityCommandBinding {
  /** Deployment command id selected at Gate C. */
  id: QualityCommandId
  /** SHA-256 of the complete normalized deployment definition. */
  definitionHash: string
  /** Gates at which this command requires fresh passing evidence. */
  requiredGates: Array<'D' | 'E'>
}

/**
 * Resource limits the Conductor enforces across a run: how many times a stage
 * may be reworked and how many fresh-worker Ralph rounds Headsman may run.
 */
export interface ConductorBudget {
  /** Maximum rework decisions at each gate before that gate escalates. */
  maxReworkPerGate: number
  /** Maximum Ralph iterations Headsman may run inside one approved baseline. */
  maxRalphRounds: number
  /** Maximum accepted owner-directed reassessments at each gate, independently of rework. */
  maxOwnerReassessmentsPerGate: number
  /** Maximum estimated input tokens reserved for each critic attempt. */
  maxCriticInputTokensPerAttempt: number
  /** Maximum reasoning-inclusive output tokens reserved for each critic attempt. */
  maxCriticOutputTokensPerAttempt: number
  /** Maximum total critic tokens across the admitted run. */
  maxCriticTokensPerRun: number
}

/**
 * The immutable execution baseline Conductor records after Gate C. Headsman
 * implements against exactly this scope, plan, and acceptance version; a
 * material deviation returns as a change request instead of silently widening
 * the run.
 */
export interface ExecutionBaseline {
  /** Version of the Detective-approved scope. */
  scopeVersion: string
  /** Version of the Strategist-approved plan. */
  planVersion: string
  /** Version of the acceptance criteria the Auditor verifies against. */
  acceptanceVersion: string
  /** Paths Headsman is authorized to write. */
  allowedPaths: string[]
  /** Paths excluded from every write regardless of `allowedPaths`. */
  excludedPaths: string[]
  /** Reference that locates the state to roll back to if execution fails. */
  rollbackReference: string
  /** Host-resolved immutable command bindings selected at Gate C. */
  qualityCommands: QualityCommandBinding[]
}

/** The model-authored Gate-C baseline proposal before host catalog resolution. */
export interface ExecutionBaselineProposal extends Omit<ExecutionBaseline, 'qualityCommands' | 'allowedPaths' | 'excludedPaths'> {
  /** Deployment command ids requested for the immutable baseline. */
  qualityCommandIds: string[]
}

/** Policy stage a quality command may serve. */
export type QualityPolicyStage = 'headsman' | 'auditor'

/** Actual executor: Ralph uses Headsmans policy without owning Gate D. */
export type QualityExecutorStage = QualityPolicyStage | 'ralph'

/** Host classification for an unsuccessful quality execution. */
export type QualityExecutionFailure =
  | 'nonzero-exit'
  | 'signal'
  | 'timeout'
  | 'cancelled'
  | 'denied'
  | 'runner-failure'
  | 'sandbox-unavailable'

/** Durable host-owned evidence for one exact catalog command execution. */
export interface QualityExecutionRecord {
  evidenceId: QualityEvidenceId
  runId: ConductorRunId
  childSessionId: SessionId
  commandId: QualityCommandId
  definitionHash: string
  executionBaselineHash: string
  gate: 'D' | 'E'
  cycle: number
  policyStage: QualityPolicyStage
  executorStage: QualityExecutorStage
  outcome: 'passed' | 'failed'
  failure?: QualityExecutionFailure
  exitCode: number | null
  signal: string | null
  startedAt: string
  finishedAt: string
  stdoutSha256: string
  stderrSha256: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

/**
 * One run's lifecycle status. `closed` and `aborted` are terminal; resume is
 * rejected for both. `rework` and `escalated` mark a run parked on a gate
 * decision that needs a fix or an owner decision; `awaiting_authorization`
 * marks a GO whose release action still lacks explicit authority.
 */
export type ConductorRunStatus =
  | 'running'
  | 'awaiting_owner'
  | 'continuation_pending'
  | 'awaiting_authorization'
  | 'rework'
  | 'escalated'
  | 'closed'
  | 'aborted'
  | 'reported'

/**
 * The durable, authoritative record of one Conductor run. Conductor is the only
 * owner of this state: specialists return envelopes, never mutate the run, and
 * never choose the next stage. `history` holds every gate decision so The
 * Arbiter can review the full record.
 */
export interface ConductorRun {
  /** Pre-release durable record format; unsupported versions are rejected without migration. */
  recordFormatVersion: 5
  /** Actual owning root session; null only when no host session was captured. */
  ownerSessionId: SessionId | null
  /** Immutable capabilities captured by the admitting host, never supplied by a specialist. */
  ownerCapabilities: OwnerMandate | null
  /** Monotonic owner-ledger revision, independent of gate-history offsets. */
  ownerRevision: number
  /** Append-only questions, accepted answers, single-use consumption and rejection. */
  ownerLedger: OwnerInteraction[]
  /** Immutable, captured owner inputs and validated entry selection. */
  admission: ConductorAdmission
  /** Pending prerequisite repairs, in causal stack order. */
  repairReturns: RepairReturn[]
  /** Active read-only dispatch mode; null outside an analysis producer or critic. */
  analysisMode: 'producer' | 'critic' | null
  /** Validated analysis reports retained in dispatch order. */
  analysisReports: AnalysisEnvelope[]
  /** Append-only report versions; audits must name the latest exact hash. */
  reportCandidates: CapturedReport[]
  /** Append-only validated critiques bound to their exact report candidates. */
  analysisChallenges: CapturedAnalysisChallenge[]
  /** The final report-specific verdict; accept produces status reported. */
  reportDecision?: ReportDecision
  /** The run's id. */
  runId: ConductorRunId
  /** The desired outcome. */
  objective: string
  /** The files, components, or concerns included in the run. */
  scope: string[]
  /** Artifacts supplied at intake and available to every specialist. */
  inputArtifacts: string[]
  /** Owner-authorized roots that write-capable stages may modify. */
  allowedPaths: string[]
  /** Owner-declared roots excluded from every specialist write. */
  excludedPaths: string[]
  /** Source state observed at intake; Detective may establish it when absent. */
  sourceBaseline: string | null
  /** The mandate owner, used for attribution only. */
  authority: ConductorAuthority
  /** Non-negotiable constraints on the work. */
  constraints: string[]
  /** The measurable criteria each gate's pass is judged against. */
  acceptanceCriteria: string[]
  /** Rework and Ralph round limits. */
  budget: ConductorBudget
  /** Every host-authorized Gate-C baseline, retained append-only across rework. */
  baselineHistory: ExecutionBaseline[]
  /** The active immutable execution baseline; null until Gate C passes or after scope/plan rework. */
  baseline: ExecutionBaseline | null
  /** Host-owned authorization for the active baseline, or null before approval and after invalidation. */
  executionAuthorization: ExecutionAuthorization | null
  /** The stage the run is currently at. */
  currentStage: ConductorStage
  /** Every gate decision recorded so far, in order. */
  history: GateRecord[]
  /** Validated specialist envelopes retained for downstream handoffs and Arbiter review. */
  specialistReports: SpecialistEnvelope[]
  /** Host-owned command evidence accumulated before Gate D and Gate E decisions. */
  qualityExecutions: QualityExecutionRecord[]
  /** The run's lifecycle status. */
  status: ConductorRunStatus
  /** The Arbiter decision recorded at Gate G, when reached. */
  decision?: DecisionRecord
  /** The explicit, record-only closeout authorization and evidence, when closed. */
  closeout?: CloseoutRecord
}

/** The seven gates A–G, one per gated stage (Detective through Arbiter). */
export type GateId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G'

/**
 * Conductor's decision at a gate — distinct from a specialist's envelope
 * `status`. `pass` requires fresh evidence against the acceptance criteria;
 * `rework` routes a known, bounded fix to the responsible stage; `escalate`
 * defers to the mandate owner; `abort` stops the run.
 */
export type GateDecision = 'pass' | 'rework' | 'escalate' | 'abort'

/** The class of defect a rework addresses, used to route the fix to the right stage. */
export type DefectClass = 'scope' | 'plan' | 'implementation' | 'delivery' | 'report' | 'analysis'

/**
 * One recorded gate decision. Conductor owns this record and appends it to
 * {@link ConductorRun.history}; a specialist's `status` is never recorded as a
 * decision. `defectClass` is set on `rework`; `nextStage` is set on `pass`,
 * `rework`, and `escalate` but absent on `abort`.
 */
export interface EvaluatedGateRecord {
  /** An actual runtime evaluation, distinct from an explicitly skipped gate. */
  kind: 'evaluated'
  /** Host-detected insufficiency before a specialist is dispatched. */
  origin?: 'intake-validation' | 'critic-budget'
  /** The gate letter. */
  gate: GateId
  /** The gated stage this gate judged (one of the seven Detective–Arbiter stages). */
  stage: ConductorStage
  /** Conductor's decision. */
  decision: GateDecision
  /** The concrete evidence and reasoning behind the decision. */
  basis: string[]
  /** The artifacts and outputs reviewed at this gate. */
  evidenceReviewed: string[]
  /** For `rework`: the class of defect the fix addresses. */
  defectClass?: DefectClass
  /** The stage Conductor routes to next; set on `pass`, `rework`, and `escalate`. */
  nextStage?: ConductorStage
  /** Short, concrete description of the run-state change this decision applies. */
  stateUpdate: string
  /** Hash of the active execution baseline for Gate C pass and every later attempt under it. */
  executionBaselineHash?: string
  /** Exact producer or critic dispatch at analysis Gate C. */
  analysis?: {
    mode: 'producer' | 'critic'
    candidateHash?: string
    childId?: SessionId
    criticAttempt?: number
    challengeHash?: string
    inputTokens?: number
    outputTokens?: number
    conclusion?: 'holds' | 'does_not_hold'
  }
}

/** A runtime-owned bypass with captured evidence; it is never a gate pass. */
export interface SkippedGateRecord {
  kind: 'skipped'
  gate: GateId
  stage: ConductorStage
  decision: 'skipped'
  reason: 'supplied-work' | 'profile-not-applicable'
  basis: string[]
  evidenceReviewed: string[]
  nextStage: ConductorStage
  stateUpdate: string
  purpose: 'implementation' | 'analysis'
  deliverable?: ReportDeliverable
  route: ConductorStage[]
  defectClass?: never
  executionBaselineHash?: never
}

/** Evaluated decisions and explicit, evidence-backed bypasses in causal order. */
export type GateRecord = EvaluatedGateRecord | SkippedGateRecord

/** A specialist's delivery readiness — never a gate pass (Conductor decides that). */
export type SpecialistStatus = 'ready' | 'rework' | 'blocked' | 'failed'

/** A repairable report defect or an authority violation that must stop immediately. */
export interface SpecialistProblem {
  /** Report defects retry the reporting role; authority violations never retry. */
  kind: 'report' | 'authority'
  /** Concrete validation failure recorded in the gate history. */
  message: string
}

/** The kind of evidence an item points to. */
export type EvidenceKind = 'command' | 'file' | 'test' | 'review' | 'external'

/** One piece of evidence a specialist cites: a command, file, test, review, or external source. */
export interface EvidenceItem {
  /** What kind of evidence this is. */
  kind: EvidenceKind
  /** The path, command, or identifier that locates the evidence. */
  reference: string
  /** What the evidence shows. */
  outcome: string
}

/** Finding severity, from `low` to `critical`. */
export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical'

/** One finding tied to concrete evidence. */
export interface Finding {
  /** Stable finding id (for example `DET-001`). */
  id: string
  /** How severe the finding is. */
  severity: FindingSeverity
  /** The concrete finding. */
  description: string
  /** Why the finding matters. */
  impact: string
}

/** What a change request targets. */
export type ChangeRequestTarget = 'scope' | 'plan' | 'baseline' | 'authority'

/** A request to change scope, plan, baseline, or authority — returned instead of silently widening the run. */
export interface ChangeRequest {
  /** What the requested change targets. */
  target: ChangeRequestTarget
  /** Why the change is needed. */
  reason: string
  /** The impact accepting the change would have. */
  impact: string
  /** Concrete amendment, still subject to host capability validation and owner consent. */
  proposal?: OwnerMandateProposal
}

/**
 * The only transition a specialist may recommend: back to Conductor. No
 * specialist names the next specialist; Conductor alone routes onward.
 */
export interface RecommendedTransition {
  /** Fixed target — always Conductor. */
  target: 'conductor'
  /** What Conductor should evaluate before routing. */
  rationale: string
}

/** A specialist's confidence in its own result. */
export type Confidence = 'low' | 'medium' | 'high'

/**
 * The structured result a specialist returns, in the wire vocabulary the
 * `conductor-specialist` skill specifies. Fields are snake_case to match the
 * model-written YAML. A malformed envelope is repaired by the same role within
 * its gate budget; authority violations escalate without retry.
 */
export interface SpecialistEnvelope {
  /** The run id this result belongs to. */
  run_id: string
  /** The dispatched role/stage name. */
  stage: string
  /** Source or execution baseline the specialist actually assessed. */
  baseline_ref: string
  /** Source baseline established by a ready Detective when intake did not supply one. */
  source_baseline?: string
  /** Delivery readiness — not a gate decision. */
  status: SpecialistStatus
  /** Concise result. */
  summary: string
  /** Cited evidence. */
  evidence: EvidenceItem[]
  /** Findings tied to evidence. */
  findings: Finding[]
  /** Assumptions the specialist made. */
  assumptions: string[]
  /** Blockers that stopped the work. */
  blockers: string[]
  /** Artifacts produced or located. */
  artifacts: string[]
  /** Requests to change scope, plan, baseline, or authority. */
  change_requests: ChangeRequest[]
  /** Candidate immutable execution baseline; required for a ready Gate C result. */
  execution_baseline?: ExecutionBaseline
  /** Host evidence ids cited by this specialist; free-form evidence cannot replace them. */
  quality_evidence_ids: string[]
  /** The only allowed transition: back to Conductor. */
  recommended_transition: RecommendedTransition
  /** The specialist's confidence in its result. */
  confidence: Confidence
}

/** The Arbiter's release decision. */
export type ArbiterDecision = 'go' | 'no-go'

/**
 * The Arbiter's structured decision, in the wire vocabulary the
 * `conductor-closeout` skill specifies. Conductor records it without rewriting.
 * A `go` moves the run to closeout; it never grants commit, push, merge, or
 * deploy authority by itself.
 */
export interface DecisionRecord {
  /** The run id this decision belongs to. */
  run_id: string
  /** GO or NO-GO. */
  decision: ArbiterDecision
  /** The evidence and reasoning behind the decision. */
  basis: string[]
  /** The artifacts reviewed to reach the decision. */
  evidence_reviewed: string[]
  /** Conditions the decision attaches. */
  conditions: string[]
  /** Risks that remain open after the decision. */
  open_risks: string[]
  /** Follow-up work the decision requires. */
  required_follow_up: string[]
}

/** An action named in an explicit closeout authorization. `record-only` performs no external action. */
export type ConductorCloseoutAction = ConductorAction | 'record-only'

/** Evidence-backed closeout input supplied by the mandate owner after an Arbiter GO. */
export interface CloseoutAuthorization {
  /** Must exactly match the run's mandate owner. */
  authorizedBy: string
  /** Action whose completed outcome is being recorded; the runtime never performs it. */
  action: ConductorCloseoutAction
  /** Concrete evidence that the named action completed, or that record-only closeout is appropriate. */
  outcomeEvidence: string[]
  /** Concrete actions already performed outside Conductor and now being recorded. */
  actionsTaken: string[]
  /** Remaining facts that were not verified. */
  unverifiedItems: string[]
  /** Risks that remain open after closeout. */
  openRisks: string[]
  /** Owned follow-up and the condition that makes it due. */
  followUp: { owner: string; dueCondition: string }[]
  /** Evidence links grouped by lifecycle concern. */
  traceability: {
    mandate: string[]
    baseline: string[]
    changes: string[]
    verification: string[]
    decision: string[]
  }
}

/** Durable closeout record created only from an explicit {@link CloseoutAuthorization}. */
export interface CloseoutRecord {
  /** Run this closeout belongs to. */
  run_id: string
  /** Arbiter decision that opened closeout. */
  arbiter_decision: 'go'
  /** Mandate owner who explicitly authorized the recorded action. */
  authorized_by: string
  /** Authorized action recorded by closeout; no action is executed by Conductor. */
  authorized_action: ConductorCloseoutAction
  /** Concrete actions already performed outside Conductor. */
  actions_taken: string[]
  /** Evidence of the action's outcome. */
  outcome_evidence: string[]
  /** Facts left unverified at closeout. */
  unverified_items: string[]
  /** Risks left open at closeout. */
  open_risks: string[]
  /** Owned follow-up with an explicit triggering condition. */
  follow_up: { owner: string; due_condition: string }[]
  /** Evidence links grouped by lifecycle concern. */
  traceability: {
    mandate: string[]
    baseline: string[]
    changes: string[]
    verification: string[]
    decision: string[]
  }
  /** Terminal run status. */
  status: 'closed'
}
