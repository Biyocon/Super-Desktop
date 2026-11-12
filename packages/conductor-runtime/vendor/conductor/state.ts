/**
 * Conductor run state machine and gate engine.
 *
 * Conductor is the only owner of a run's workflow state. This module owns the
 * gate sequence (A through G), derives each gate letter from the run's current
 * stage, appends the resulting {@link GateRecord}, and advances the run's
 * stage and status. A specialist never mutates the run and never chooses the
 * next stage; {@link recordGate} is the single transition point.
 *
 * @module @deepseek-ai/dsh-conductor/state
 */

import type {
  ConductorAuthority,
  ConductorBudget,
  CloseoutAuthorization,
  CloseoutRecord,
  ConductorRun,
  ConductorRunId,
  ConductorRunStatus,
  ConductorStage,
  DefectClass,
  GateDecision,
  GateId,
  GateRecord,
  ConductorAdmission,
  EvaluatedGateRecord,
} from './types.ts'
import { executionBaselineHash, executionEffectProfile } from './quality.ts'
import { admittedRoute, GATED_STAGES, reportProducer, requireAnalysisCriteria, transitionRoute } from './intake.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { OwnerMandate } from './owner-types.ts'

/** Current pre-release durable Conductor record format. */
export const CONDUCTOR_RECORD_FORMAT_VERSION = 5

/**
 * The initial, dispatch-ready run state. The run starts at its admitted A/B/C entry with
 * explicit prior skips and no execution baseline (implementation authorizes one at C).
 */
export interface CreateRunInput {
  /** Actual host-owned root session; omitted only by consumers without a session. */
  ownerSessionId?: SessionId
  /** Immutable workspace and command capabilities captured by the admitting host. */
  ownerCapabilities?: OwnerMandate
  /** Host-captured, validated purpose, entry and material provenance. */
  admission: ConductorAdmission
  /** The desired outcome. */
  objective: string
  /** Files, components, or concerns included in the run. */
  scope?: string[]
  /** Artifacts supplied at intake. */
  inputArtifacts?: string[]
  /** Owner-authorized roots that write-capable stages may modify. */
  allowedPaths?: string[]
  /** Owner-declared roots excluded from every specialist write. */
  excludedPaths?: string[]
  /** Source state observed at intake, when already known. */
  sourceBaseline?: string
  /** The mandate owner, used for attribution only. */
  authority: ConductorAuthority
  /** Non-negotiable constraints on the work. */
  constraints?: string[]
  /** Measurable deliverable requirements; at least one is required for analysis. */
  acceptanceCriteria?: string[]
  /** Limits retained at admission; omitted critic limits use the shipped Config defaults. */
  budget?: Pick<ConductorBudget, 'maxReworkPerGate' | 'maxRalphRounds'>
    & Partial<Omit<ConductorBudget, 'maxReworkPerGate' | 'maxRalphRounds'>>
}

/**
 * Build a fresh run at its admitted entry, recording supplied-work skips.
 * @param runId - the minted run id.
 * @param input - the mandate that bounds the run.
 * @returns the initial run.
 */
export function createRun(runId: ConductorRunId, input: CreateRunInput): ConductorRun {
  if (input.budget?.maxOwnerReassessmentsPerGate !== undefined
    && (!Number.isSafeInteger(input.budget.maxOwnerReassessmentsPerGate) || input.budget.maxOwnerReassessmentsPerGate < 1)) {
    throw new Error('Conductor maxOwnerReassessmentsPerGate must be a positive safe integer')
  }
  const criticBudget = {
    maxCriticInputTokensPerAttempt: input.budget?.maxCriticInputTokensPerAttempt ?? 24_000,
    maxCriticOutputTokensPerAttempt: input.budget?.maxCriticOutputTokensPerAttempt ?? 16_000,
    maxCriticTokensPerRun: input.budget?.maxCriticTokensPerRun ?? 120_000,
  }
  for (const [field, value] of Object.entries(criticBudget)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Conductor ${field} must be a positive safe integer`)
  }
  if (criticBudget.maxCriticTokensPerRun
    < criticBudget.maxCriticInputTokensPerAttempt + criticBudget.maxCriticOutputTokensPerAttempt) {
    throw new Error('Conductor maxCriticTokensPerRun must cover one maximum critic attempt')
  }
  const acceptanceCriteria = [...(input.acceptanceCriteria ?? [])]
  requireAnalysisCriteria(input.admission, acceptanceCriteria)
  const run: ConductorRun = {
    recordFormatVersion: CONDUCTOR_RECORD_FORMAT_VERSION,
    ownerSessionId: input.ownerSessionId ?? null,
    ownerCapabilities: input.ownerCapabilities === undefined ? null : structuredClone(input.ownerCapabilities),
    ownerRevision: 0,
    ownerLedger: [],
    admission: structuredClone(input.admission),
    repairReturns: [],
    analysisMode: input.admission.purpose === 'analysis' && input.admission.entry === reportProducer(input.admission)
      ? 'producer' : null,
    analysisReports: [],
    reportCandidates: [],
    analysisChallenges: [],
    runId,
    objective: input.objective,
    scope: [...(input.scope ?? [])],
    inputArtifacts: [...(input.inputArtifacts ?? [])],
    allowedPaths: [...(input.allowedPaths ?? [])],
    excludedPaths: [...(input.excludedPaths ?? [])],
    sourceBaseline: input.sourceBaseline ?? null,
    authority: { owner: input.authority.owner },
    constraints: [...(input.constraints ?? [])],
    acceptanceCriteria,
    budget:
      input.budget === undefined
        ? { maxReworkPerGate: 2, maxRalphRounds: 0, maxOwnerReassessmentsPerGate: 2, ...criticBudget }
        : { ...input.budget, maxOwnerReassessmentsPerGate: input.budget.maxOwnerReassessmentsPerGate ?? 2,
          ...criticBudget },
    baselineHistory: [],
    baseline: null,
    executionAuthorization: null,
    currentStage: 'detective',
    history: [],
    specialistReports: [],
    qualityExecutions: [],
    status: 'running',
  }
  return skipUntil(run, input.admission.entry, 'supplied-work')
}

const GATE_OF_STAGE: Record<ConductorStage, GateId | undefined> = {
  intake: undefined,
  detective: 'A',
  strategist: 'B',
  'devils-advocate': 'C',
  headsman: 'D',
  ralph: undefined,
  auditor: 'E',
  integrator: 'F',
  arbiter: 'G',
  closeout: undefined,
  'report-complete': undefined,
}

const STAGE_OF_GATE: Record<GateId, ConductorStage> = {
  A: 'detective',
  B: 'strategist',
  C: 'devils-advocate',
  D: 'headsman',
  E: 'auditor',
  F: 'integrator',
  G: 'arbiter',
}

const NEXT_AFTER_PASS: Partial<Record<ConductorStage, ConductorStage>> = {
  detective: 'strategist',
  strategist: 'devils-advocate',
  'devils-advocate': 'headsman',
  headsman: 'auditor',
  auditor: 'integrator',
  integrator: 'arbiter',
  arbiter: 'closeout',
}

/**
 * The gate letter a stage owns, or undefined for non-gated stages
 * (`intake`, `ralph`, `closeout`, `report-complete`).
 * @param stage - the stage to look up.
 * @returns the gate letter, or undefined when the stage owns no gate.
 */
export function gateOfStage(stage: ConductorStage): GateId | undefined {
  return GATE_OF_STAGE[stage]
}

/**
 * The gated stage a gate letter decides.
 * @param gate - the gate letter (A through G).
 * @returns the corresponding stage.
 */
export function stageOfGate(gate: GateId): ConductorStage {
  return STAGE_OF_GATE[gate]
}

/**
 * The stage a `pass` at `stage`'s gate advances to. The linear pass path is
 * Detective → Strategist → Devil's Advocate → Headsman → Auditor → Integrator →
 * Arbiter → closeout.
 * @param stage - the current gated stage.
 * @returns the next stage, or undefined when `stage` has no pass successor.
 */
export function nextStageAfterPass(stage: ConductorStage): ConductorStage | undefined {
  return NEXT_AFTER_PASS[stage]
}

/**
 * How many rework decisions this run has already recorded at one gate.
 * @param run - the run to count.
 * @param gate - the gate whose independent budget is being checked.
 * @returns the number of matching gate records with decision `rework`.
 */
export function reworkCycles(run: ConductorRun, gate: GateId): number {
  let count = 0
  for (const record of run.history) {
    if (record.gate === gate && record.decision === 'rework') count += 1
  }
  return count
}

/**
 * One gate decision as Conductor records it, before the engine derives the
 * gate letter and the terminal/pass transitions. `defectClass` and `nextStage`
 * are required for a `rework` (within budget); `nextStage` is optional for an
 * explicit `escalate` and ignored for `pass`/`abort`.
 */
export interface GateVerdict {
  /** Runtime admission repair before a specialist has started. */
  origin?: 'intake-validation' | 'critic-budget'
  /** Conductor's decision. */
  decision: GateDecision
  /** The concrete evidence and reasoning behind the decision. */
  basis: string[]
  /** The artifacts and outputs reviewed at this gate. */
  evidenceReviewed: string[]
  /** For `rework`: the defect class routing the fix to the right stage. */
  defectClass?: DefectClass
  /** The stage to route next; required for `rework`, optional for `escalate`. */
  nextStage?: ConductorStage
  /** Short, concrete description of the run-state change this decision applies. */
  stateUpdate: string
  /** Exact baseline hash for Gate C pass and later attempts under an active baseline. */
  executionBaselineHash?: string
  /** Host-owned analysis dispatch identity and measured cost at Gate C. */
  analysis?: EvaluatedGateRecord['analysis']
}

/**
 * Record one gate decision against the run's current stage and advance state.
 * The gate letter is derived from {@link ConductorRun.currentStage}; a
 * specialist cannot name it. A `pass` advances along the linear pass path; a
 * `rework` within {@link ConductorBudget.maxReworkPerGate} routes to the
 * supplied target; a `rework` past that budget is recorded as `escalate`
 * instead of silently reworking again.
 *
 * The returned run is a new value — the input run is never mutated.
 * @param run - the run to transition (must not be `closed` or `aborted`).
 * @param verdict - the decision to record.
 * @returns the updated run with the record appended to `history`.
 */
export function recordGate(run: ConductorRun, verdict: GateVerdict): ConductorRun {
  if (run.status === 'awaiting_owner' || run.status === 'continuation_pending') {
    throw new Error(`Conductor run ${run.runId} is ${run.status}; consume its exact owner continuation before further gate decisions`)
  }
  if (run.status === 'closed' || run.status === 'aborted' || run.status === 'reported') {
    throw new Error(`Conductor run ${run.runId} is ${run.status}; no further gate decisions`)
  }

  const gate = gateOfStage(run.currentStage)
  if (gate === undefined) {
    throw new Error(`Conductor stage "${run.currentStage}" owns no gate; cannot record a gate decision`)
  }

  const activeBaselineHash = run.baseline === null ? undefined : executionBaselineHash(run.baseline)
  if (run.admission.purpose === 'analysis' && (run.baseline !== null || run.executionAuthorization !== null
    || run.baselineHistory.length > 0 || run.qualityExecutions.length > 0)) {
    throw new Error('Conductor analysis cannot carry execution authority or command evidence')
  }
  if (verdict.origin === 'critic-budget' && (run.admission.purpose !== 'analysis' || gate !== 'C'
    || run.analysisMode !== 'critic' || verdict.decision !== 'escalate' || verdict.analysis !== undefined)) {
    throw new Error('Conductor critic budget can escalate only before a Gate C child dispatch')
  }
  if (run.admission.purpose === 'analysis' && verdict.analysis?.mode === 'producer') {
    if (run.currentStage !== reportProducer(run.admission) || run.analysisMode !== 'producer'
      || !verdict.analysis.childId) throw new Error('Conductor producer gate requires its admitted child and mode')
    if (verdict.decision === 'pass' && (verdict.analysis.candidateHash !== run.reportCandidates.at(-1)?.hash
      || verdict.analysis.childId !== run.reportCandidates.at(-1)?.producerChildId)) {
      throw new Error('Conductor producer pass requires its exact candidate and child identity')
    }
  }
  if (run.admission.purpose === 'analysis' && gate === 'C' && verdict.origin === undefined) {
    if (verdict.analysis?.mode !== run.analysisMode) {
      throw new Error('Conductor analysis Gate C decision must name the active producer or critic mode')
    }
    if (verdict.decision === 'pass' && (verdict.analysis.candidateHash !== run.reportCandidates.at(-1)?.hash
      || !verdict.analysis.childId)) {
      throw new Error('Conductor analysis Gate C pass requires the exact candidate and child')
    }
    if (verdict.analysis.mode === 'critic' && verdict.analysis.childId !== undefined
      && (!Number.isSafeInteger(verdict.analysis.criticAttempt) || Number(verdict.analysis.criticAttempt) < 1
        || (verdict.analysis.inputTokens === undefined) !== (verdict.analysis.outputTokens === undefined)
        || verdict.analysis.inputTokens !== undefined
          && (!Number.isSafeInteger(verdict.analysis.inputTokens) || verdict.analysis.inputTokens < 0)
        || verdict.analysis.outputTokens !== undefined
          && (!Number.isSafeInteger(verdict.analysis.outputTokens) || verdict.analysis.outputTokens < 0))) {
      throw new Error('Conductor analysis critic attempt requires a positive attempt and measured token usage')
    }
    if (verdict.analysis.mode === 'critic' && verdict.analysis.childId !== undefined
      && verdict.decision === 'rework' && verdict.analysis.inputTokens === undefined) {
      throw new Error('Conductor critic retry requires measured token usage')
    }
    if (verdict.analysis.mode === 'critic' && verdict.analysis.challengeHash !== undefined) {
      const captured = run.analysisChallenges.at(-1)
      if (captured?.hash !== verdict.analysis.challengeHash
        || captured.candidateHash !== verdict.analysis.candidateHash
        || captured.criticChildId !== verdict.analysis.childId
        || captured.criticAttempt !== verdict.analysis.criticAttempt) {
        throw new Error('Conductor analysis Gate C challenge does not match its validated critic attempt')
      }
      const critical = captured.challenge.findings.some(finding => finding.severity === 'critical')
      const target = captured.challenge.conclusion === 'does_not_hold'
        ? captured.challenge.defect === 'scope' ? 'detective' : captured.challenge.defect === 'plan' ? 'strategist'
          : reportProducer(run.admission) : undefined
      if ((captured.challenge.conclusion === 'holds') !== (verdict.decision === 'pass')
        || captured.challenge.conclusion !== verdict.analysis.conclusion
        || captured.challenge.conclusion === 'does_not_hold' && verdict.decision === 'rework'
          && verdict.defectClass !== captured.challenge.defect
        || captured.challenge.conclusion === 'does_not_hold' && !critical && verdict.nextStage !== target
        || critical && verdict.decision !== 'escalate') {
        throw new Error('Conductor analysis Gate C decision conflicts with its validated challenge')
      }
    } else if (verdict.analysis.mode === 'critic' && verdict.decision === 'rework'
      && (verdict.defectClass !== 'report' || verdict.nextStage !== 'devils-advocate')) {
      throw new Error('Malformed critic output may rework only the critic at Gate C')
    }
    if (verdict.decision === 'pass' && verdict.analysis.mode === 'critic'
      && (verdict.analysis.challengeHash === undefined || verdict.analysis.conclusion !== 'holds')) {
      throw new Error('Conductor analysis Gate C critic pass requires a holding challenge')
    }
  }
  if (run.admission.purpose === 'implementation' && gate === 'C' && verdict.decision === 'pass') {
    if (activeBaselineHash === undefined || run.executionAuthorization === null) {
      throw new Error('Conductor Gate C pass requires a host-authorized execution baseline')
    }
    if (run.executionAuthorization.executionBaselineHash !== activeBaselineHash) {
      throw new Error('Conductor Gate C authorization does not match the active execution baseline')
    }
    const requiredProfile = executionEffectProfile(run.baseline as NonNullable<ConductorRun['baseline']>)
    const approvedProfile = run.executionAuthorization.effectProfile
    if (approvedProfile.filesystem !== requiredProfile.filesystem
      || approvedProfile.quality !== requiredProfile.quality) {
      throw new Error('Conductor Gate C authorization does not match the required execution effects')
    }
    if (verdict.executionBaselineHash !== activeBaselineHash) {
      throw new Error('Conductor Gate C pass requires the active execution baseline hash')
    }
  } else if (verdict.executionBaselineHash !== undefined
    && verdict.executionBaselineHash !== activeBaselineHash) {
    throw new Error(`Conductor gate ${gate} execution baseline hash does not match the active baseline`)
  }

  let decision: GateDecision = verdict.decision
  let nextStage: ConductorStage | undefined

  switch (verdict.decision) {
    case 'pass':
      break
    case 'rework': {
      if (verdict.defectClass === undefined) {
        throw new Error(`Conductor gate ${gate} rework requires a defect class`)
      }
      if (verdict.nextStage === undefined) {
        throw new Error(`Conductor gate ${gate} rework requires a rework target stage`)
      }
      if (verdict.defectClass === 'report' && verdict.nextStage !== run.currentStage
        && !(run.admission.purpose === 'analysis' && run.currentStage === 'devils-advocate'
          && verdict.analysis?.mode === 'critic' && verdict.analysis.challengeHash !== undefined
          && verdict.nextStage === reportProducer(run.admission))) {
        throw new Error(`Conductor gate ${gate} report rework must return to its reporting stage`)
      }
      nextStage = verdict.nextStage
      if (reworkCycles(run, gate) >= run.budget.maxReworkPerGate) {
        decision = 'escalate'
      }
      break
    }
    case 'escalate':
      nextStage = verdict.nextStage
      break
    case 'abort':
      nextStage = undefined
      break
    /* v8 ignore start -- GateDecision is a closed typed union; a future variant must fail loud here. */
    default:
      assertNever(verdict.decision)
    /* v8 ignore stop */
  }

  const producerPassedAtC = run.admission.purpose === 'analysis' && gate === 'C'
    && verdict.analysis?.mode === 'producer' && decision === 'pass'
  const transition = producerPassedAtC
    ? { nextStage: 'devils-advocate' as const, repairReturns: [...run.repairReturns] }
    : transitionRoute(run, decision, verdict.defectClass, nextStage)
  const destination = transition.nextStage
  const fromIndex = (GATED_STAGES as readonly string[]).indexOf(run.currentStage)
  const toIndex = (GATED_STAGES as readonly string[]).indexOf(destination ?? '')
  nextStage = decision === 'pass' && toIndex > fromIndex + 1 ? GATED_STAGES[fromIndex + 1] : destination

  let status: ConductorRunStatus
  switch (decision) {
    case 'pass':
      status = gate === 'G' ? (run.admission.purpose === 'analysis' ? 'reported' : 'awaiting_authorization') : 'running'
      break
    case 'rework':
      status = 'rework'
      break
    case 'escalate':
      status = 'escalated'
      break
    case 'abort':
      status = 'aborted'
      break
    /* v8 ignore start -- GateDecision is a closed typed union; a future variant must fail loud here. */
    default:
      assertNever(decision)
    /* v8 ignore stop */
  }

  const record: EvaluatedGateRecord = {
    kind: 'evaluated',
    ...verdict.origin === undefined ? {} : { origin: verdict.origin },
    gate,
    stage: run.currentStage,
    decision,
    basis: verdict.decision === 'rework' && decision === 'escalate'
      ? [...verdict.basis, `Gate ${gate} exhausted its ${run.budget.maxReworkPerGate} reworks per gate`]
      : verdict.basis,
    evidenceReviewed: verdict.evidenceReviewed,
    stateUpdate: verdict.stateUpdate,
    ...verdict.analysis === undefined ? {} : { analysis: verdict.analysis },
  }
  const requiredBaselineHash = run.admission.purpose === 'analysis' ? undefined : gate === 'C' && decision === 'pass'
    ? verdict.executionBaselineHash
    : gate === 'D' || gate === 'E' || gate === 'F' || gate === 'G'
      ? activeBaselineHash
      : undefined
  if (requiredBaselineHash !== undefined) record.executionBaselineHash = requiredBaselineHash
  if (decision === 'rework' && verdict.defectClass !== undefined) {
    record.defectClass = verdict.defectClass
  }
  if (nextStage !== undefined) {
    record.nextStage = nextStage
  }

  const updated: ConductorRun = {
    ...run,
    ...decision === 'rework' && (verdict.defectClass === 'scope' || verdict.defectClass === 'plan')
      ? { baseline: null, executionAuthorization: null }
      : {},
    currentStage: nextStage ?? run.currentStage,
    analysisMode: run.admission.purpose !== 'analysis' || decision === 'abort' ? null
      : decision === 'escalate' ? run.analysisMode
        : producerPassedAtC ? 'critic'
          : decision === 'rework' && verdict.analysis?.mode === 'critic' && verdict.analysis.challengeHash === undefined
            ? 'critic'
            : destination === reportProducer(run.admission)
              ? 'producer'
              : decision === 'pass' && destination === 'devils-advocate' && run.reportCandidates.length > 0
                ? 'critic' : null,
    status,
    history: [...run.history, record],
    repairReturns: transition.repairReturns,
  }
  return decision === 'pass' && destination !== undefined ? skipUntil(updated, destination, 'profile-not-applicable') : updated
}

function skipUntil(run: ConductorRun, target: ConductorStage, reason: 'supplied-work' | 'profile-not-applicable'): ConductorRun {
  let current = run
  const order = GATED_STAGES as readonly ConductorStage[]
  // Admission and transitionRoute supply only initial-entry or forward-gap intervals.
  for (const stage of order.slice(order.indexOf(run.currentStage), order.indexOf(target))) {
    const nextStage = order[order.indexOf(stage) + 1] as ConductorStage
    const gate = gateOfStage(stage) as GateId
    const record: GateRecord = {
      kind: 'skipped', gate, stage: current.currentStage, decision: 'skipped', reason,
      basis: [current.admission.rationale],
      evidenceReviewed: current.admission.materials.map(material => material.id),
      nextStage, stateUpdate: `skip ${gate}: ${reason}`,
      purpose: current.admission.purpose,
      ...current.admission.purpose === 'analysis' ? { deliverable: current.admission.deliverable } : {},
      route: admittedRoute(current.admission),
    }
    current = { ...current, currentStage: nextStage, history: [...current.history, record] }
  }
  return current
}

/**
 * Close a run after Gate G from an explicit mandate-owner authorization.
 * This function records an already-authorized action and evidence; it never
 * executes commit, push, merge, deploy, or any other external side effect.
 * @param run - a GO run parked at closeout.
 * @param authorization - explicit owner authorization and outcome evidence.
 * @returns a new terminal run carrying its closeout record.
 */
export function closeRun(run: ConductorRun, authorization: CloseoutAuthorization): ConductorRun {
  if (run.admission.purpose === 'analysis') throw new Error('Conductor analysis cannot close out an execution or grant GO')
  if (run.currentStage !== 'closeout' || run.status !== 'awaiting_authorization') {
    throw new Error(`Conductor run ${run.runId} is not awaiting closeout authorization`)
  }
  if (run.decision?.decision !== 'go') {
    throw new Error(`Conductor run ${run.runId} has no recorded Arbiter GO`)
  }
  if (authorization.authorizedBy !== run.authority.owner) {
    throw new Error(`closeout authorization must come from mandate owner "${run.authority.owner}"`)
  }
  if (authorization.outcomeEvidence.length === 0
    || authorization.outcomeEvidence.some(item => item.length === 0 || item !== item.trim())) {
    throw new Error('closeout authorization requires normalized outcome evidence')
  }
  const normalizedLists = [
    authorization.actionsTaken,
    authorization.unverifiedItems,
    authorization.openRisks,
    authorization.traceability.mandate,
    authorization.traceability.baseline,
    authorization.traceability.changes,
    authorization.traceability.verification,
    authorization.traceability.decision,
  ]
  if (normalizedLists.some(items => items.some(item => item.length === 0 || item !== item.trim()))) {
    throw new Error('closeout authorization lists must contain normalized strings')
  }
  if (authorization.followUp.some(item => item.owner.length === 0
    || item.owner !== item.owner.trim()
    || item.dueCondition.length === 0
    || item.dueCondition !== item.dueCondition.trim())) {
    throw new Error('closeout follow-up requires a normalized owner and due condition')
  }
  const closeout: CloseoutRecord = {
    run_id: run.runId,
    arbiter_decision: 'go',
    authorized_by: authorization.authorizedBy,
    authorized_action: authorization.action,
    actions_taken: [...authorization.actionsTaken],
    outcome_evidence: [...authorization.outcomeEvidence],
    unverified_items: [...authorization.unverifiedItems],
    open_risks: [...authorization.openRisks],
    follow_up: authorization.followUp.map(item => ({
      owner: item.owner,
      due_condition: item.dueCondition,
    })),
    traceability: {
      mandate: [...authorization.traceability.mandate],
      baseline: [...authorization.traceability.baseline],
      changes: [...authorization.traceability.changes],
      verification: [...authorization.traceability.verification],
      decision: [...authorization.traceability.decision],
    },
    status: 'closed',
  }
  return { ...run, status: 'closed', closeout }
}

/* v8 ignore start -- closed typed switches call this only if their declared unions gain an unhandled member. */
function assertNever(value: never): never {
  throw new Error(`Unreachable gate decision: ${String(value)}`)
}
/* v8 ignore stop */
