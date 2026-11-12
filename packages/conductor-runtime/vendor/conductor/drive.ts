/**
 * Conductor state-machine driver.
 *
 * The driver owns the dispatch loop: it asks a {@link ConductorDispatcher} to
 * run the stage's specialist, validates the returned wire record, routes it
 * through {@link routeGate}, records the gate with {@link recordGate}, and
 * repeats until the run reaches the Arbiter's decision or a terminal blocker.
 * The driver never spawns subagents itself — the dispatcher abstracts that seam
 * so the loop is testable against stubbed specialists.
 *
 * @module @deepseek-ai/dsh-conductor/drive
 */

import type {
  ArbiterDecision,
  ConductorRun,
  ConductorStage,
  DecisionRecord,
  DefectClass,
  ExecutionBaseline,
  ExecutionAuthorization,
  ExecutionEffectProfile,
  QualityCommandBinding,
  QualityExecutionRecord,
  SpecialistEnvelope,
  SpecialistProblem,
  SpecialistStatus,
  CapturedReport,
  ConductorEntry,
  ReportDecision,
} from './types.ts'
import type { validateAnalysisChallenge } from './analysis-challenge.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { driveAnalysis } from './analysis.ts'
import type { OwnerEscalation } from './owner-types.ts'
import { effectiveOwnerMandate, ownerCommandAllowed, ownerEscalationForProblem } from './owner-ledger.ts'
import { gateOfStage, recordGate } from './state.ts'
import { routeGate } from './routing.ts'
import {
  executionBaselineHash,
  executionEffectProfile,
  nextQualityCycle,
  snapshotQualityBindings,
} from './quality.ts'

/** Host-owned result of one specialist dispatch. */
export interface SpecialistDispatchResult {
  /** Model-authored specialist envelope after boundary validation. */
  envelope: SpecialistEnvelope
  /** Model-boundary validation failure discovered while resolving host-owned fields. */
  boundaryProblem?: SpecialistProblem
  /** Host-produced records completed during this dispatch. */
  qualityExecutions: QualityExecutionRecord[]
  /** Stage-applicable baseline bindings that this gate requires. */
  requiredQualityCommands: QualityCommandBinding[]
}

/** An execution fault, carrying host evidence without claiming a specialist report or gate verdict. */
export class SpecialistExecutionFailure extends Error {
  /**
   * @param cause - the original infrastructure failure.
   * @param stage - the dispatch stage at the time of failure.
   * @param childStarted - whether runtime observed that stage's child start.
   * @param qualityExecutions - completed host-owned command records to checkpoint before propagation.
   */
  constructor(
    cause: unknown,
    readonly stage: ConductorStage,
    readonly childStarted: boolean,
    readonly qualityExecutions: readonly QualityExecutionRecord[] = [],
  ) {
    super(String(cause), { cause })
  }
}

/**
 * Spawns specialists and the Arbiter. A dispatcher rejects only on an
 * infrastructure fault; completed host records travel in
 * {@link SpecialistExecutionFailure} and are checkpointed before propagation.
 * An ordinary specialist-reported failure resolves with a `blocked`/`failed`
 * envelope, which the driver routes to escalation.
 */
export interface ConductorDispatcher {
  /**
   * Run the specialist for `stage` and return its structured envelope.
   * @param stage - the gated stage to dispatch (never `intake`, `ralph`, `closeout`, or `arbiter`).
   * @param run - the current run snapshot.
   */
  dispatchSpecialist(
    stage: ConductorStage,
    run: ConductorRun,
  ): Promise<unknown>
  /** Run the admitted report producer and retain its fresh child identity. */
  dispatchAnalysisProducer?(stage: ConductorEntry, run: ConductorRun): Promise<{ value: unknown; childId: SessionId }>
  /** Run one bounded critic attempt, or report why no attempt can start. */
  dispatchCritic?(run: ConductorRun, criticAttempt: number): Promise<CriticDispatchResult>
  /**
   * Ask the host to authorize the exact Gate-C baseline and effect profile.
   * A null result is an explicit rejection; a rejection or thrown infrastructure
   * failure blocks the run before any write-capable specialist is dispatched.
   * @param run - run snapshot before Gate C passes.
   * @param baseline - resolved immutable baseline proposed for approval.
   * @param effectProfile - exact effects required by that baseline.
   */
  authorizeExecution(
    run: ConductorRun,
    baseline: ExecutionBaseline,
    effectProfile: ExecutionEffectProfile,
  ): Promise<ExecutionAuthorization | null>
  /**
   * Run the Arbiter and return its GO/NO-GO decision.
   * @param run - the current run snapshot with its full gate history.
   */
  dispatchArbiter(run: ConductorRun): Promise<unknown>
}

/** Host-measured critic attempt, including malformed structured output. */
export type CriticDispatchResult =
  | {
    kind: 'attempt'
    childId: SessionId
    inputTokens: number
    outputTokens: number
    validation: ReturnType<typeof validateAnalysisChallenge>
  }
  | {
    kind: 'blocked'
    problem: SpecialistProblem
    childId?: SessionId
    criticAttempt?: number
    inputTokens?: number
    outputTokens?: number
  }

/** Durable checkpoint writer called after every gate transition. */
export type ConductorCheckpoint = (run: ConductorRun) => Promise<void>

/** A terminal driver outcome: the Arbiter's decision, or a blocker. */
export type ConductorOutcome =
  | { readonly kind: 'decision'; readonly decision: DecisionRecord; readonly run: ConductorRun }
  | { readonly kind: 'blocked'; readonly blocker: string; readonly run: ConductorRun; readonly ownerEscalation?: OwnerEscalation | undefined }
  | { readonly kind: 'report'; readonly report: CapturedReport; readonly decision: ReportDecision; readonly run: ConductorRun }

/**
 * Drive a run from its current stage to the Arbiter's decision or a blocker.
 *
 * Each specialist is dispatched at the stage the run is currently at; a `pass`
 * advances along the linear path, a `rework` routes to the defect-owning stage
 * (bounded by {@link ConductorBudget.maxReworkPerGate} inside {@link recordGate}),
 * and a `blocked`/`failed` result parks the run for an owner decision. A
 * malformed report retries the reporting role within that gate's budget;
 * authority violations and rejected approval escalate immediately.
 * @param run - the initial or resumed run.
 * @param dispatcher - the specialist and Arbiter spawner.
 * @param checkpoint - durable checkpoint writer called after every gate transition.
 * @returns the terminal outcome carrying the final run state.
 */
export async function drive(
  run: ConductorRun,
  dispatcher: ConductorDispatcher,
  checkpoint: ConductorCheckpoint = () => Promise.resolve(),
): Promise<ConductorOutcome> {
  let current = run
  if (current.status === 'awaiting_owner' || current.status === 'continuation_pending') {
    throw new Error('Conductor owner resumption requires an exact host reservation; the run remains parked')
  }
  if (!current.history.some(record => record.kind === 'evaluated') && current.admission.entry !== 'detective') {
    const lacksBaseline = current.admission.purpose === 'implementation' && current.sourceBaseline === null
    const lacksScope = lacksBaseline || current.admission.scopeSources.length === 0
      || current.scope.length === 0 || current.acceptanceCriteria.length === 0
    const lacksPlan = current.admission.entry === 'devils-advocate' && current.admission.planSources.length === 0
    if (lacksScope || lacksPlan) {
      current = recordGate(current, {
        origin: 'intake-validation', decision: 'rework', defectClass: lacksScope ? 'scope' : 'plan',
        nextStage: lacksScope ? 'detective' : 'strategist',
        basis: [lacksBaseline ? 'implementation entry requires a source baseline established by Detective or supplied explicitly'
          : lacksScope ? 'entry requires captured scope material' : 'entry requires captured plan material'],
        evidenceReviewed: current.admission.materials.map(material => material.id), stateUpdate: 'repair insufficient intake material',
      })
      await checkpoint(current)
    }
  }
  if (current.admission.purpose === 'analysis') return driveAnalysis(current, dispatcher, checkpoint)
  while (true) {
    const stage = current.currentStage
    if (stage === 'arbiter') {
      return await settleArbiter(current, dispatcher, checkpoint)
    }
    if (stage === 'intake' || stage === 'ralph' || stage === 'closeout' || stage === 'report-complete') {
      throw new Error(`Conductor drive cannot dispatch stage "${stage}"`)
    }
    if ((stage === 'headsman' || stage === 'auditor' || stage === 'integrator')
      && current.baseline === null) {
      throw new Error(`Conductor stage "${stage}" requires the immutable Gate C execution baseline`)
    }
    const gate = gateOfStage(stage)
    /* v8 ignore next -- the preceding stage guards narrow the closed ConductorStage union to gated stages. */
    if (gate === undefined) {
      throw new Error(`Conductor stage "${stage}" owns no gate`)
    }

    let dispatched: unknown
    try {
      dispatched = await dispatcher.dispatchSpecialist(stage, current)
    } catch (cause) {
      if (cause instanceof SpecialistExecutionFailure && cause.qualityExecutions.length > 0) {
        current = { ...current, qualityExecutions: [...current.qualityExecutions, ...structuredClone(cause.qualityExecutions)] }
        await checkpoint(current)
      }
      throw cause
    }
    const dispatch: SpecialistDispatchResult = typeof dispatched === 'object' && dispatched !== null && 'envelope' in dispatched
      ? dispatched as SpecialistDispatchResult
      : { envelope: dispatched as SpecialistEnvelope, qualityExecutions: [], requiredQualityCommands: [] }
    const envelope = dispatch.envelope
    const qualityExecutions = [...current.qualityExecutions, ...structuredClone(dispatch.qualityExecutions)]
    const malformed = envelopeProblem(envelope, stage, current)
    const problem = envelopeAuthorityProblem(envelope, stage, current)
      ?? dispatch.boundaryProblem
      ?? (malformed === undefined ? undefined : { kind: 'report' as const, message: malformed })
    if (problem !== undefined) {
      current = recordGate({ ...current, qualityExecutions }, {
        decision: problem.kind === 'report' ? 'rework' : 'escalate',
        ...problem.kind === 'report' ? { defectClass: 'report' as const, nextStage: stage } : {},
        basis: [problem.message],
        evidenceReviewed: [],
        stateUpdate: `reject ${problem.kind} problem in ${stage} envelope`,
      })
      await checkpoint(current)
      if (current.status === 'rework') continue
      return { kind: 'blocked', blocker: problem.message, run: current, ownerEscalation: ownerEscalationForProblem(problem) }
    }
    const evidenceProblem = dispatchEvidenceProblem(envelope, dispatch.qualityExecutions, current.qualityExecutions)
    if (evidenceProblem !== undefined) {
      current = recordGate({ ...current, qualityExecutions }, {
        decision: 'escalate',
        basis: [evidenceProblem],
        evidenceReviewed: dispatch.qualityExecutions.map(record => record.evidenceId),
        stateUpdate: `reject invalid ${stage} quality evidence references`,
      })
      await checkpoint(current)
      return { kind: 'blocked', blocker: evidenceProblem, run: current }
    }
    const specialistReports = [...current.specialistReports, structuredClone(envelope)]
    if (envelope.change_requests.some(request => request.target === 'authority')) {
      const reason = envelope.change_requests.map(request => request.reason).join('; ')
      current = recordGate({ ...current, specialistReports, qualityExecutions }, {
        decision: 'escalate', basis: [reason], evidenceReviewed: envelope.evidence.map(item => item.reference),
        stateUpdate: 'owner mandate amendment requested; execution remains unauthorized',
      })
      await checkpoint(current)
      return { kind: 'blocked', blocker: reason, run: current,
        ownerEscalation: { kind: 'recoverable',
          cause: envelope.change_requests.some(request => request.proposal !== undefined) ? 'authority-amendment' : 'clarification', reason } }
    }
    const passProblem = gatePassProblem(envelope, { ...current, qualityExecutions }, dispatch.requiredQualityCommands)
    if (passProblem !== undefined) {
      current = recordGate({ ...current, specialistReports, qualityExecutions }, {
        decision: 'escalate',
        basis: [passProblem],
        evidenceReviewed: [...envelope.evidence.map(item => item.reference), ...envelope.quality_evidence_ids],
        stateUpdate: `reject unsupported ${stage} readiness claim`,
      })
      await checkpoint(current)
      return { kind: 'blocked', blocker: passProblem, run: current }
    }

    let baseline: ExecutionBaseline | null = current.baseline
    let baselineHistory = current.baselineHistory
    let executionAuthorization = current.executionAuthorization
    let sourceBaseline = current.sourceBaseline
    if (gate === 'A' && envelope.status === 'ready' && sourceBaseline === null) {
      sourceBaseline = envelope.source_baseline as string
    }
    if (gate === 'C' && envelope.status === 'ready') {
      const baselineProblem = executionBaselineProblem(envelope.execution_baseline, current)
      if (baselineProblem !== undefined) {
        current = recordGate(current, {
          decision: 'rework',
          defectClass: 'report',
          nextStage: stage,
          basis: [baselineProblem],
          evidenceReviewed: envelope.evidence.map(item => item.reference),
          stateUpdate: 'reject Gate C result without a valid execution baseline',
        })
        await checkpoint(current)
        if (current.status === 'rework') continue
        return { kind: 'blocked', blocker: baselineProblem, run: current,
          ownerEscalation: { kind: 'recoverable', cause: 'rework-exhausted', reason: baselineProblem } }
      }
      baseline = snapshotBaseline(envelope.execution_baseline as ExecutionBaseline)
      const profile = executionEffectProfile(baseline)
      let authorization: ExecutionAuthorization | null
      try {
        authorization = await dispatcher.authorizeExecution(current, baseline, profile)
      } catch (cause) {
        const blocker = `execution authorization unavailable: ${errorMessage(cause)}`
        current = recordGate({ ...current, specialistReports }, {
          decision: 'escalate',
          basis: [blocker],
          evidenceReviewed: envelope.evidence.map(item => item.reference),
          stateUpdate: 'Gate C execution authorization unavailable',
        })
        await checkpoint(current)
        return { kind: 'blocked', blocker, run: current }
      }
      if (authorization === null) {
        const blocker = 'execution authorization rejected by host'
        current = recordGate({ ...current, specialistReports }, {
          decision: 'escalate',
          basis: [blocker],
          evidenceReviewed: envelope.evidence.map(item => item.reference),
          stateUpdate: 'Gate C execution authorization rejected',
        })
        await checkpoint(current)
        return { kind: 'blocked', blocker, run: current }
      }
      const authorizationProblem = executionAuthorizationProblem(authorization, baseline, profile)
      if (authorizationProblem !== undefined) {
        current = recordGate({ ...current, specialistReports }, {
          decision: 'escalate',
          basis: [authorizationProblem],
          evidenceReviewed: envelope.evidence.map(item => item.reference),
          stateUpdate: 'reject mismatched Gate C execution authorization',
        })
        await checkpoint(current)
        return { kind: 'blocked', blocker: authorizationProblem, run: current }
      }
      executionAuthorization = structuredClone(authorization)
      baselineHistory = [...current.baselineHistory, snapshotBaseline(baseline)]
    }

    const defectClass = envelope.status === 'rework' ? defectClassFromEnvelope(envelope, stage) : undefined
    current = recordGate({
      ...current,
      baseline,
      baselineHistory,
      executionAuthorization,
      sourceBaseline,
      specialistReports,
      qualityExecutions,
    }, {
      ...routeGate(gate, envelope.status, defectClass),
      basis: [envelope.summary],
      evidenceReviewed: [...envelope.evidence.map(item => item.reference), ...envelope.quality_evidence_ids],
      stateUpdate: envelope.summary,
      ...gate === 'C' && envelope.status === 'ready' && baseline !== null
        ? { executionBaselineHash: executionBaselineHash(baseline) }
        : {},
    })
    await checkpoint(current)

    if (current.status === 'running' || current.status === 'rework') continue
    return {
      kind: 'blocked',
      blocker: `run ${current.status} at gate ${gate}`,
      run: current,
      ...envelope.status === 'rework' || (envelope.status === 'blocked' && envelope.change_requests.length > 0)
        ? { ownerEscalation: { kind: 'recoverable', cause: envelope.status === 'rework' ? 'rework-exhausted' : 'clarification', reason: envelope.summary } as const } : {},
    }
  }
}

/** Record the Arbiter's decision and either move to closeout (GO) or escalate (NO-GO). */
async function settleArbiter(
  initial: ConductorRun,
  dispatcher: ConductorDispatcher,
  checkpoint: ConductorCheckpoint,
): Promise<ConductorOutcome> {
  let current = initial
  while (true) {
    const rawDecision = await dispatcher.dispatchArbiter(current)
    const malformed = decisionProblem(rawDecision, current)
    if (malformed !== undefined) {
      const identityMismatch = isObject(rawDecision) && nonEmptyText(rawDecision['run_id']) && rawDecision['run_id'] !== current.runId
      const run = recordGate(current, {
        decision: identityMismatch ? 'escalate' : 'rework',
        defectClass: 'report',
        nextStage: 'arbiter',
        basis: [malformed],
        evidenceReviewed: [],
        stateUpdate: 'reject malformed arbiter decision',
      })
      await checkpoint(run)
      if (run.status === 'rework') {
        current = run
        continue
      }
      return { kind: 'blocked', blocker: malformed, run,
        ...identityMismatch ? {} : { ownerEscalation: { kind: 'recoverable', cause: 'rework-exhausted', reason: malformed } as const } }
    }
    const decision = rawDecision as DecisionRecord
    if (decision.decision === 'go') {
      const run = {
        ...recordGate(current, {
          decision: 'pass',
          basis: decision.basis,
          evidenceReviewed: decision.evidence_reviewed,
          stateUpdate: 'arbiter GO — move to closeout',
        }),
        decision,
      }
      await checkpoint(run)
      return { kind: 'decision', decision, run }
    }
    const run = recordGate(current, {
      decision: 'escalate',
      basis: decision.basis,
      evidenceReviewed: decision.evidence_reviewed,
      stateUpdate: 'arbiter NO-GO — escalate to owner',
    })
    await checkpoint(run)
    return { kind: 'blocked', blocker: 'arbiter returned NO-GO', run }
  }
}

const SPECIALIST_STATUSES: readonly SpecialistStatus[] = ['ready', 'rework', 'blocked', 'failed']
const ARBITER_DECISIONS: readonly ArbiterDecision[] = ['go', 'no-go']

/** Detect identity, source, routing, and authority violations before attempting report repair. */
function envelopeAuthorityProblem(envelope: unknown, stage: ConductorStage, run: ConductorRun): SpecialistProblem | undefined {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return undefined
  const value = envelope as Record<string, unknown>
  for (const [key, expected] of [['run_id', run.runId], ['stage', stage]] as const) {
    if (nonEmptyText(value[key]) && value[key] !== expected) {
      return { kind: 'authority', message: `envelope ${key} does not match ${expected}` }
    }
  }
  const baseline = run.baseline?.rollbackReference ?? run.sourceBaseline
  if (baseline !== null && nonEmptyText(value['baseline_ref']) && value['baseline_ref'] !== baseline) {
    return { kind: 'authority', message: `envelope baseline_ref does not match assessed baseline ${baseline}` }
  }
  const transition = value['recommended_transition']
  if (typeof transition === 'object' && transition !== null && 'target' in transition
    && nonEmptyText(transition.target) && transition.target !== 'conductor') {
    return { kind: 'authority', message: 'envelope recommended_transition must target "conductor"' }
  }
  const proposed = value['execution_baseline']
  if (stage === 'devils-advocate' && isObject(proposed) && Array.isArray(proposed['qualityCommands'])
    && proposed['qualityCommands'].some(binding => isObject(binding) && nonEmptyText(binding['id']) && !ownerCommandAllowed(run, binding['id']))) {
    return { kind: 'authority', message: 'Gate C command selection exceeds the effective owner mandate' }
  }
  return undefined
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

/** Structural wire validation for a specialist envelope; returns a reason or undefined. */
function envelopeProblem(envelope: unknown, stage: ConductorStage, run: ConductorRun): string | undefined {
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    return 'specialist returned no structured envelope'
  }
  const value = envelope as Record<string, unknown>
  if (value['run_id'] !== run.runId) {
    return `envelope run_id does not match ${run.runId}`
  }
  if (value['stage'] !== stage) {
    return `envelope stage does not match dispatched stage ${stage}`
  }
  if (!nonEmptyText(value['baseline_ref'])) {
    return 'envelope baseline_ref must identify the assessed source or execution baseline'
  }
  const expectedBaseline = run.baseline?.rollbackReference ?? run.sourceBaseline
  if (expectedBaseline !== null && value['baseline_ref'] !== expectedBaseline) {
    return `envelope baseline_ref does not match assessed baseline ${expectedBaseline}`
  }
  if (!isOneOf(value['status'], SPECIALIST_STATUSES)) {
    return `envelope status is invalid: ${String(value['status'])}`
  }
  if (stage === 'detective' && run.sourceBaseline === null && value['status'] === 'ready') {
    if (!nonEmptyText(value['source_baseline'])) {
      return 'a ready Detective must establish source_baseline when intake did not supply one'
    }
    if (value['baseline_ref'] !== value['source_baseline']) {
      return 'Detective baseline_ref must match the established source_baseline'
    }
  }
  if (!nonEmptyText(value['summary'])) {
    return 'envelope summary must be a non-empty normalized string'
  }
  if (!isArray(value['evidence']) || !isArray(value['findings']) || !isArray(value['assumptions'])
    || !isArray(value['blockers']) || !isArray(value['artifacts']) || !isArray(value['change_requests'])
    || !isStringArray(value['quality_evidence_ids'])) {
    return 'envelope list fields must be arrays'
  }
  for (const field of ['assumptions', 'blockers', 'artifacts']) {
    if (!isStringArray(value[field])) return `envelope ${field} must contain normalized strings`
  }
  for (const item of value['evidence']) {
    if (!isObject(item) || !isOneOf(item['kind'], ['command', 'file', 'test', 'review', 'external'])
      || !nonEmptyText(item['reference']) || !nonEmptyText(item['outcome'])) {
      return 'envelope evidence must contain a valid kind and normalized reference and outcome'
    }
  }
  for (const item of value['findings']) {
    if (!isObject(item) || !isOneOf(item['severity'], ['low', 'medium', 'high', 'critical'])
      || !['id', 'description', 'impact'].every(key => nonEmptyText(item[key]))) {
      return 'envelope findings must contain an id, severity, description, and impact'
    }
  }
  for (const item of value['change_requests']) {
    if (!isObject(item) || !isOneOf(item['target'], ['scope', 'plan', 'baseline', 'authority'])
      || !nonEmptyText(item['reason']) || !nonEmptyText(item['impact'])) {
      return 'envelope change_requests must contain a target, reason, and impact'
    }
    const proposal = item['proposal']
    if (proposal !== undefined && (item['target'] !== 'authority' || !isObject(proposal)
      || Object.keys(proposal).some(key => !['allowedPaths', 'excludedPaths', 'qualityCommandIds'].includes(key))
      || !isStringArray(proposal['allowedPaths']) || !isStringArray(proposal['excludedPaths']) || !isStringArray(proposal['qualityCommandIds']))) {
      return 'only authority change_requests may include a complete concrete mandate proposal'
    }
  }
  const transition = value['recommended_transition']
  if (typeof transition !== 'object' || transition === null
    || (transition as Record<string, unknown>)['target'] !== 'conductor'
    || !nonEmptyText((transition as Record<string, unknown>)['rationale'])) {
    return 'envelope recommended_transition must target "conductor"'
  }
  if (!isOneOf(value['confidence'], ['low', 'medium', 'high'])) {
    return 'envelope confidence is invalid'
  }
  return undefined
}

/** Structural validation for the Gate C execution baseline. */
function executionBaselineProblem(value: unknown, run: ConductorRun): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'a ready Gate C result requires execution_baseline'
  }
  const baseline = value as Record<string, unknown>
  for (const key of ['scopeVersion', 'planVersion', 'acceptanceVersion', 'rollbackReference']) {
    if (!nonEmptyText(baseline[key])) return `execution_baseline.${key} must be a non-empty normalized string`
  }
  if (!isStringArray(baseline['allowedPaths']) || !isStringArray(baseline['excludedPaths'])) {
    return 'execution_baseline allowedPaths and excludedPaths must contain normalized strings'
  }
  if (!sameStrings(baseline['allowedPaths'], effectiveOwnerMandate(run).allowedPaths)) {
    return 'execution_baseline.allowedPaths must exactly match the owner-authorized run paths'
  }
  if (!sameStrings(baseline['excludedPaths'], effectiveOwnerMandate(run).excludedPaths)) {
    return 'execution_baseline.excludedPaths must exactly match the owner-declared exclusions'
  }
  if (!Array.isArray(baseline['qualityCommands'])) {
    return 'execution_baseline.qualityCommands must be an array'
  }
  const commandIds = new Set<string>()
  for (const value of baseline['qualityCommands']) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return 'execution_baseline.qualityCommands must contain bindings'
    }
    const binding = value as Record<string, unknown>
    if (!nonEmptyText(binding['id']) || !/^[a-f0-9]{64}$/.test(String(binding['definitionHash']))) {
      return 'execution_baseline quality bindings require a normalized id and SHA-256 definitionHash'
    }
    if (commandIds.has(binding['id'])) return 'execution_baseline quality command ids must be unique'
    commandIds.add(binding['id'])
  }
  return undefined
}

/** Validate host authorization against the exact baseline and requested effects. */
function executionAuthorizationProblem(
  authorization: ExecutionAuthorization,
  baseline: ExecutionBaseline,
  profile: ExecutionEffectProfile,
): string | undefined {
  if (authorization.executionBaselineHash !== executionBaselineHash(baseline)) {
    return 'execution authorization does not match the Gate C baseline hash'
  }
  if (authorization.effectProfile.filesystem !== profile.filesystem
    || authorization.effectProfile.quality !== profile.quality) {
    return 'execution authorization does not match the Gate C effect profile'
  }
  return undefined
}

/** Require specialist evidence ids to be the exact current dispatch record set. */
function dispatchEvidenceProblem(
  envelope: SpecialistEnvelope,
  dispatched: readonly QualityExecutionRecord[],
  previous: readonly QualityExecutionRecord[],
): string | undefined {
  const cited = envelope.quality_evidence_ids
  if (new Set(cited).size !== cited.length) return 'quality_evidence_ids must be unique'
  const dispatchedIds = dispatched.map(record => record.evidenceId)
  if (new Set(dispatchedIds).size !== dispatchedIds.length) return 'dispatch quality evidence ids must be unique'
  const previousIds = new Set<string>(previous.map(record => record.evidenceId))
  if (dispatchedIds.some(id => previousIds.has(id))) return 'dispatch quality evidence ids must not reuse prior evidence'
  const citedSet = new Set(cited)
  const dispatchedSet = new Set<string>(dispatchedIds)
  if (cited.some(id => !dispatchedSet.has(id)) || dispatchedIds.some(id => !citedSet.has(id))) {
    return 'quality_evidence_ids must exactly match the current dispatch evidence records'
  }
  return undefined
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Copy a wire baseline so later model-owned mutation cannot alter run state. */
function snapshotBaseline(value: ExecutionBaseline): ExecutionBaseline {
  return {
    scopeVersion: value.scopeVersion,
    planVersion: value.planVersion,
    acceptanceVersion: value.acceptanceVersion,
    allowedPaths: [...value.allowedPaths],
    excludedPaths: [...value.excludedPaths],
    rollbackReference: value.rollbackReference,
    qualityCommands: snapshotQualityBindings(value.qualityCommands),
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(item => typeof item === 'string' && item.length > 0 && item === item.trim())
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function gatePassProblem(
  envelope: SpecialistEnvelope,
  run: ConductorRun,
  requiredQualityCommands: readonly QualityCommandBinding[],
): string | undefined {
  if (envelope.status !== 'ready') return undefined
  if (!isStringArray(run.acceptanceCriteria) || run.acceptanceCriteria.length === 0) {
    return 'a gate pass requires at least one normalized acceptance criterion'
  }
  if (envelope.evidence.length === 0) return 'a ready specialist must provide fresh evidence before Conductor can pass the gate'
  if ((run.currentStage === 'headsman' || run.currentStage === 'auditor') && requiredQualityCommands.length > 0) {
    const baseline = run.baseline as ExecutionBaseline
    const gate = run.currentStage === 'headsman' ? 'D' : 'E'
    const cycle = nextQualityCycle(run, gate)
    const baselineHash = executionBaselineHash(baseline)
    const cited = new Set(envelope.quality_evidence_ids)
    for (const binding of requiredQualityCommands) {
      const record = run.qualityExecutions.find(item => cited.has(item.evidenceId)
        && item.commandId === binding.id
        && item.definitionHash === binding.definitionHash
        && item.runId === run.runId
        && item.gate === gate
        && item.cycle === cycle
        && item.executionBaselineHash === baselineHash
        && item.policyStage === run.currentStage
        && item.outcome === 'passed')
      if (record === undefined) {
        return `Gate ${gate} requires fresh passing quality evidence for command "${binding.id}"`
      }
    }
  }
  return undefined
}

/** Structural wire validation for an Arbiter decision; returns a reason or undefined. */
function decisionProblem(decision: unknown, run: ConductorRun): string | undefined {
  if (typeof decision !== 'object' || decision === null || Array.isArray(decision)) {
    return 'arbiter returned no structured decision'
  }
  const value = decision as Record<string, unknown>
  if (value['run_id'] !== run.runId) {
    return `arbiter decision run_id does not match ${run.runId}`
  }
  if (!isOneOf(value['decision'], ARBITER_DECISIONS)) {
    return `arbiter decision is invalid: ${String(value['decision'])}`
  }
  for (const field of ['basis', 'evidence_reviewed', 'conditions', 'open_risks', 'required_follow_up']) {
    if (!isStringArray(value[field])) {
      return `arbiter decision ${field} must contain only non-empty normalized strings`
    }
  }
  const basis = value['basis'] as string[]
  const evidenceReviewed = value['evidence_reviewed'] as string[]
  if (value['decision'] === 'go'
    && (!isStringArray(run.acceptanceCriteria) || run.acceptanceCriteria.length === 0
      || basis.length === 0 || evidenceReviewed.length === 0)) {
    return 'an Arbiter GO requires acceptance criteria, a non-empty basis, and reviewed evidence'
  }
  return undefined
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Derive a rework defect class from the envelope's change requests, else from the stage. */
function defectClassFromEnvelope(envelope: SpecialistEnvelope, stage: ConductorStage): DefectClass {
  for (const request of envelope.change_requests) {
    switch (request.target) {
      case 'scope':
        return 'scope'
      case 'plan':
      case 'baseline':
        return 'plan'
      /* v8 ignore next 2 -- authority requests are escalated before rework routing reaches this classifier. */
      case 'authority':
        break
      /* v8 ignore start -- ChangeRequest.target is a closed typed union; a future variant must fail loud here. */
      default:
        assertNever(request.target)
      /* v8 ignore stop */
    }
  }
  switch (stage) {
    case 'detective':
      return 'scope'
    case 'strategist':
    case 'devils-advocate':
      return 'plan'
    case 'headsman':
    case 'auditor':
      return 'implementation'
    case 'integrator':
    case 'arbiter':
      return 'delivery'
    /* v8 ignore start -- drive rejects non-gated stages before deriving a rework class. */
    case 'intake':
    case 'ralph':
    case 'closeout':
    case 'report-complete':
      throw new Error(`stage "${stage}" owns no rework defect class`)
    /* v8 ignore stop */
  }
}

/* v8 ignore start -- closed typed switches call this only if their declared unions gain an unhandled member. */
function assertNever(value: never): never {
  throw new Error(`Unreachable drive value: ${String(value)}`)
}
/* v8 ignore stop */
