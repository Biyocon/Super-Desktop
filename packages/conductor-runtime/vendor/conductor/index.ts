/**
 * Conductor run-state runtime entry point.
 *
 * This package owns the Conductor run and gate vocabulary, state machine,
 * host-authorized execution baseline, durable evidence lineage, and persistence.
 * This entry point exposes those contracts to runtime consumers.
 * @module @deepseek-ai/dsh-conductor
 */

export { ConductorRunId, QualityCommandId, QualityEvidenceId } from './types.ts'
export type { OwnerTransportBinding } from './owner-types.ts'
export { decodeOwnerInteractionEvent, publishOwnerInteractions, decodeOwnerAcknowledgement, publishOwnerAcknowledgement } from './owner-events.ts'
export type { OwnerInteractionEvent, OwnerAcknowledgement } from './owner-events.ts'
export type { OwnerAnswer, OwnerEscalation, OwnerInteraction, OwnerMandate, OwnerMandateProposal, OwnerQuestion, OwnerQuestionItem, OwnerQuestionSource, OwnerResumePlan, RecoverableOwnerCause, ScriptedOwnerResponse, TerminalOwnerCause } from './owner-types.ts'
export { applyScriptedOwnerAnswer, assertOwnerLedger, consumeOwnerContinuation, effectiveOwnerMandate, ownerCommandAllowed, ownerContinuationAt, ownerLifecycleStatus, ownerMandateHash, ownerReassessments, parkOwnerQuestion, pendingOwnerQuestion, pendingOwnerResumePlan } from './owner-ledger.ts'
export type {
  ArbiterDecision,
  ChangeRequest,
  ChangeRequestTarget,
  ConductorAction,
  ExecutionAuthorization,
  ExecutionEffectProfile,
  ConductorAuthority,
  ConductorBudget,
  ConductorCloseoutAction,
  ConductorRun,
  ConductorRunStatus,
  ConductorStage,
  Confidence,
  CloseoutAuthorization,
  CloseoutRecord,
  DecisionRecord,
  DefectClass,
  EvidenceItem,
  EvidenceKind,
  ExecutionBaseline,
  ExecutionBaselineProposal,
  Finding,
  FindingSeverity,
  GateDecision,
  GateId,
  GateRecord,
  QualityCommandBinding,
  QualityExecutionFailure,
  QualityExecutionRecord,
  QualityExecutorStage,
  QualityPolicyStage,
  RecommendedTransition,
  SpecialistEnvelope,
  SpecialistProblem,
  SpecialistStatus,
  AnalysisEnvelope,
  CapturedReport,
  CapturedAnalysisChallenge,
  ConductorAdmission,
  ConductorEntry,
  ConductorMaterialId,
  EvaluatedGateRecord,
  IntakeMaterial,
  IntakeSelection,
  RepairReturn,
  ReportCandidate,
  ReportDecision,
  ReportDeliverable,
  SkippedGateRecord,
} from './types.ts'
export { admitIntake, admittedRoute, captureIntakeMaterial, CONDUCTOR_ENTRIES, contentHash, reportProducer } from './intake.ts'
export { currentAuditHash, reportHash } from './analysis.ts'
export { buildCriticInput } from './analysis-materials.ts'
export { validateAnalysisChallenge } from './analysis-challenge.ts'
export type { AnalysisChallenge, AnalysisChallengeContext, CapturedChallengeIdentity } from './analysis-challenge.ts'
export type { AnalysisMaterialSpan } from './analysis-materials.ts'
export {
  closeRun,
  CONDUCTOR_RECORD_FORMAT_VERSION,
  createRun,
  gateOfStage,
  nextStageAfterPass,
  recordGate,
  reworkCycles,
  stageOfGate,
} from './state.ts'
export type { CreateRunInput, GateVerdict } from './state.ts'
export {
  InMemoryConductorRunStore,
  SessionConductorRunStore,
  ConductorRunUnavailableError,
  inspectRunRecord,
  parseRun,
  resumeRun,
  serializeRun,
  validateResumable,
} from './persistence.ts'
export type { ConductorCheckpointData, ConductorRunStore, InspectedConductorRun, UnavailableConductorRun } from './persistence.ts'
export { decisionForStatus, reworkTarget, routeGate } from './routing.ts'
export type { RoutedGate } from './routing.ts'
export { drive, SpecialistExecutionFailure } from './drive.ts'
export type { ConductorCheckpoint, ConductorDispatcher, ConductorOutcome, CriticDispatchResult, SpecialistDispatchResult } from './drive.ts'
export { executionBaselineHash, executionEffectProfile, nextQualityCycle, snapshotQualityBindings } from './quality.ts'
export { isValidRunId, mintRunId } from './run-id.ts'

import type { Context } from '@deepseek-ai/cordis'
import { conductorChildrenProjection } from './child-projection.ts'
import { conductorUnavailableRunsProjection } from './run-availability.ts'
export { conductorChildrenProjection }
export { conductorUnavailableRunsProjection }

/** Projection service required for persistent Conductor child catalogs. */
export const inject = ['sessionProjections']

/**
 * Mount child presentation independently of the live agent preset.
 * @param ctx - context carrying the shared projection registry.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(conductorChildrenProjection)
  ctx.sessionProjections.register(conductorUnavailableRunsProjection)
}
