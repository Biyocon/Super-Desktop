/**
 * Conductor run persistence and resume.
 *
 * A run is durable state keyed by {@link ConductorRunId}. This module defines
 * the store contract the runtime persists runs through, a JSON wire format for
 * a durable record, and the resume rules: a terminal run (`closed`/`aborted`)
 * is never resumable, and a resumable run's stage must be exactly what its last
 * documented gate produced — undocumented intermediate state is rejected.
 *
 * @module @deepseek-ai/dsh-conductor/persistence
 */

import type {
  ArbiterDecision,
  ConductorAction,
  ConductorCloseoutAction,
  ConductorRun,
  ConductorRunId,
  ConductorRunStatus,
  ConductorStage,
  DefectClass,
  GateDecision,
  GateId,
  ExecutionBaseline,
  QualityExecutionRecord,
  QualityExecutionFailure,
  QualityExecutorStage,
  QualityPolicyStage,
} from './types.ts'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { isValidRunId } from './run-id.ts'
import { executionBaselineHash, executionEffectProfile } from './quality.ts'
import { CONDUCTOR_RECORD_FORMAT_VERSION } from './state.ts'
import { parseAdmission, requireAnalysisCriteria } from './intake.ts'
import { validateIntakeHistory } from './intake-history.ts'
import { parseAnalysisState } from './analysis-persistence.ts'
import { assertOwnerLedger, effectiveOwnerMandate, ownerCommandAllowed, ownerLifecycleStatus } from './owner-ledger.ts'
import { publishOwnerInteractions, replayOwnerInteractions } from './owner-events.ts'
import type { OwnerTransportBinding } from './owner-types.ts'

/** One whole-run checkpoint in the parent Session log. A null record is a tombstone. */
export interface ConductorCheckpointData {
  /** Stable keyed run identity. */
  runId: ConductorRunId
  /** Serialized run snapshot, or null when the key was deleted. */
  record: string | null
}

/** A saved run that can be displayed as unavailable but cannot be used. */
export interface UnavailableConductorRun {
  readonly kind: 'unavailable'
  readonly format: number | null
}

/** Result of inspecting a checkpoint without granting resume authority. */
export type InspectedConductorRun = { readonly kind: 'current'; readonly run: ConductorRun } | UnavailableConductorRun

/** Safe, actionable failure for every operation that loads an unusable run. */
export class ConductorRunUnavailableError extends Error {
  /**
   * @param runId - identity of the unavailable saved run.
   * @param format - stored format number, or null when unavailable.
   */
  constructor(readonly runId: ConductorRunId, readonly format: number | null) {
    super(`Conductor run ${JSON.stringify(runId)} cannot be resumed (format ${format ?? 'unknown'}): its saved record is unsupported or invalid. Start a new run with a new runId.`)
  }
}

/** Read only the format number needed for presentation and redacted diagnostics. */
function storedRecordFormat(json: string): number | null {
  let value: unknown
  try { value = JSON.parse(json) } catch { return null }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const format: unknown = (value as Record<string, unknown>)['recordFormatVersion']
  return typeof format === 'number' && Number.isSafeInteger(format) ? format : null
}

/**
 * Inspect a logged checkpoint for read-only presentation; actions still use the strict store.
 * @param runId - keyed checkpoint identity.
 * @param record - serialized checkpoint without publication to diagnostics.
 * @param ownerSessionId - owning root when read from an agent session.
 * @returns current run or safe unavailable metadata.
 */
export function inspectRunRecord(runId: ConductorRunId, record: string, ownerSessionId?: SessionId): InspectedConductorRun {
  let run: ConductorRun
  try { run = parseRun(record) } catch { return { kind: 'unavailable', format: storedRecordFormat(record) } }
  if (run.runId !== runId || ownerSessionId !== undefined && run.ownerSessionId !== null && run.ownerSessionId !== ownerSessionId) {
    return { kind: 'unavailable', format: storedRecordFormat(record) }
  }
  return { kind: 'current', run }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Commits one complete Conductor run snapshot. Last checkpoint per run id wins.
     * @param data - run id and serialized snapshot or tombstone.
     */
    'conductor/checkpoint': ConductorCheckpointData
  }
}

const RUN_STATUSES = ['running', 'awaiting_authorization', 'rework', 'escalated', 'closed', 'aborted', 'awaiting_owner', 'continuation_pending'] as const satisfies readonly ConductorRunStatus[]
const STAGES = ['intake', 'detective', 'strategist', 'devils-advocate', 'headsman', 'ralph', 'auditor', 'integrator', 'arbiter', 'closeout'] as const satisfies readonly ConductorStage[]
const GATE_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'] as const satisfies readonly GateId[]
const GATE_DECISIONS = ['pass', 'rework', 'escalate', 'abort'] as const satisfies readonly GateDecision[]
const DEFECT_CLASSES = ['scope', 'plan', 'implementation', 'delivery', 'report'] as const satisfies readonly DefectClass[]
const ACTIONS = ['read', 'write', 'commit', 'push', 'merge', 'release', 'publish', 'deploy'] as const satisfies readonly ConductorAction[]
const CLOSEOUT_ACTIONS = ['record-only', ...ACTIONS] as const satisfies readonly ConductorCloseoutAction[]
const ARBITER_DECISIONS = ['go', 'no-go'] as const satisfies readonly ArbiterDecision[]
const SPECIALIST_STATUSES = ['ready', 'rework', 'blocked', 'failed'] as const
const EVIDENCE_KINDS = ['command', 'file', 'test', 'review', 'external'] as const
const FINDING_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
const CHANGE_TARGETS = ['scope', 'plan', 'baseline', 'authority'] as const
const CONFIDENCES = ['low', 'medium', 'high'] as const
const QUALITY_POLICY_STAGES = ['headsman', 'auditor'] as const satisfies readonly QualityPolicyStage[]
const QUALITY_EXECUTOR_STAGES = ['headsman', 'ralph', 'auditor'] as const satisfies readonly QualityExecutorStage[]
const QUALITY_FAILURES = [
  'nonzero-exit', 'signal', 'timeout', 'cancelled', 'denied', 'runner-failure', 'sandbox-unavailable',
] as const satisfies readonly QualityExecutionFailure[]

const GATE_STAGE: Readonly<Record<GateId, ConductorStage>> = {
  A: 'detective',
  B: 'strategist',
  C: 'devils-advocate',
  D: 'headsman',
  E: 'auditor',
  F: 'integrator',
  G: 'arbiter',
}
const REWORK_STAGE: Readonly<Record<Exclude<DefectClass, 'report' | 'analysis'>, ConductorStage>> = {
  scope: 'detective',
  plan: 'strategist',
  implementation: 'headsman',
  delivery: 'integrator',
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Conductor run record ${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Conductor run record ${field} must be a string`)
  return value
}

function requireNormalizedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`Conductor run record ${field} must be a non-empty normalized string`)
  }
  return value
}

function requireIsoTimestamp(value: unknown, field: string): string {
  const timestamp = requireNormalizedString(value, field)
  const millis = Date.parse(timestamp)
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== timestamp) {
    throw new Error(`Conductor run record ${field} must be an ISO timestamp`)
  }
  return timestamp
}

function requireStringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`Conductor run record ${field} must be a string array`)
  }
}

function requireNormalizedStringArray(value: unknown, field: string, distinct = false): asserts value is string[] {
  if (!Array.isArray(value)
    || value.some(item => typeof item !== 'string' || item.length === 0 || item !== item.trim())) {
    throw new Error(`Conductor run record ${field} must contain only non-empty normalized strings`)
  }
  if (distinct && new Set(value).size !== value.length) {
    throw new Error(`Conductor run record ${field} must not contain duplicates`)
  }
}

function validateBaseline(value: unknown, field = 'baseline'): void {
  if (value === null) return
  const baseline = asObject(value, field)
  requireString(baseline.scopeVersion, `${field}.scopeVersion`)
  requireString(baseline.planVersion, `${field}.planVersion`)
  requireString(baseline.acceptanceVersion, `${field}.acceptanceVersion`)
  requireNormalizedStringArray(baseline.allowedPaths, `${field}.allowedPaths`, true)
  requireNormalizedStringArray(baseline.excludedPaths, `${field}.excludedPaths`, true)
  requireNormalizedString(baseline.rollbackReference, `${field}.rollbackReference`)
  if (!Array.isArray(baseline.qualityCommands)) {
    throw new Error(`Conductor run record ${field}.qualityCommands must be an array`)
  }
  const ids = new Set<string>()
  for (const [index, value] of baseline.qualityCommands.entries()) {
    const binding = asObject(value, `${field}.qualityCommands[${index}]`)
    const exactKeys = new Set(['id', 'definitionHash', 'requiredGates'])
    for (const key of Object.keys(binding)) {
      if (!exactKeys.has(key)) {
        throw new Error(`Conductor run record ${field}.qualityCommands[${index}] contains unsupported field ${key}`)
      }
    }
    const id = requireNormalizedString(binding.id, `${field}.qualityCommands[${index}].id`)
    if (!/^[a-f0-9]{64}$/.test(requireString(binding.definitionHash, `${field}.qualityCommands[${index}].definitionHash`))) {
      throw new Error(`Conductor run record ${field}.qualityCommands[${index}].definitionHash must be SHA-256`)
    }
    if (!Array.isArray(binding.requiredGates) || binding.requiredGates.length === 0
      || binding.requiredGates.some(gate => gate !== 'D' && gate !== 'E')
      || new Set(binding.requiredGates).size !== binding.requiredGates.length) {
      throw new Error(`Conductor run record ${field}.qualityCommands[${index}].requiredGates must contain distinct D/E gates`)
    }
    if (ids.has(id)) throw new Error('Conductor run record baseline quality command ids must not contain duplicates')
    ids.add(id)
  }
}

function validatePassedQualityGates(run: ConductorRun): void {
  // Structural validation has already resolved every gate hash into baselineHistory.
  const gateCycles = new Map<string, number>()
  const gateDChildIds = new Set(run.qualityExecutions
    .filter(record => record.gate === 'D')
    .map(record => record.childSessionId))

  for (const gateRecord of run.history) {
    if (gateRecord.gate !== 'D' && gateRecord.gate !== 'E') continue
    const gate = gateRecord.gate
    const baselineHash = gateRecord.executionBaselineHash as string
    const cycleKey = `${baselineHash}:${gate}`
    const cycle = (gateCycles.get(cycleKey) ?? 0) + 1
    gateCycles.set(cycleKey, cycle)
    if (gateRecord.decision !== 'pass') continue
    const baseline = run.baselineHistory.find(candidate => executionBaselineHash(candidate) === baselineHash) as ExecutionBaseline
    const stage = gate === 'D' ? 'headsman' : 'auditor'
    const required = baseline.qualityCommands.filter(binding => binding.requiredGates.includes(gate))
    if (required.length === 0) continue
    const reviewed = new Set(gateRecord.evidenceReviewed)
    const matched: QualityExecutionRecord[] = []
    for (const binding of required) {
      const evidence = run.qualityExecutions.find(record => reviewed.has(record.evidenceId)
        && record.commandId === binding.id
        && record.definitionHash === binding.definitionHash
        && record.runId === run.runId
        && record.gate === gate
        && record.cycle === cycle
        && record.executionBaselineHash === baselineHash
        && record.policyStage === stage
        && record.outcome === 'passed')
      if (evidence === undefined) {
        throw new Error(`Conductor run record Gate ${gate} pass lacks fresh evidence for command "${binding.id}"`)
      }
      matched.push(evidence)
    }
    const evidenceIds = matched.map(record => record.evidenceId)
    const report = run.specialistReports.find(candidate => candidate.stage === stage
      && candidate.status === 'ready'
      && evidenceIds.every(id => candidate.quality_evidence_ids.includes(id)))
    if (report === undefined) {
      throw new Error(`Conductor run record Gate ${gate} pass lacks a matching ready ${stage} report`)
    }
    if (gate === 'E') {
      const auditorChildIds = new Set(matched.map(record => record.childSessionId))
      if (auditorChildIds.size !== 1 || [...auditorChildIds].some(id => gateDChildIds.has(id))) {
        throw new Error('Conductor run record Gate E pass lacks independent single-child Auditor evidence')
      }
    }
  }
}

function validateSpecialistReport(value: unknown, index: number, runId: string): void {
  const prefix = `specialistReports[${index}]`
  const report = asObject(value, prefix)
  if (report.run_id !== runId) throw new Error(`Conductor run record ${prefix}.run_id must match runId`)
  if (!isOneOf(report.stage, STAGES) || report.stage === 'intake' || report.stage === 'ralph'
    || report.stage === 'arbiter' || report.stage === 'closeout') {
    throw new Error(`Conductor run record ${prefix}.stage is invalid`)
  }
  requireString(report.baseline_ref, `${prefix}.baseline_ref`)
  if (report.source_baseline !== undefined) requireString(report.source_baseline, `${prefix}.source_baseline`)
  if (!isOneOf(report.status, SPECIALIST_STATUSES)) throw new Error(`Conductor run record ${prefix}.status is invalid`)
  requireString(report.summary, `${prefix}.summary`)
  if (!Array.isArray(report.evidence)) throw new Error(`Conductor run record ${prefix}.evidence must be an array`)
  for (const [evidenceIndex, item] of report.evidence.entries()) {
    const evidence = asObject(item, `${prefix}.evidence[${evidenceIndex}]`)
    if (!isOneOf(evidence.kind, EVIDENCE_KINDS)) throw new Error(`Conductor run record ${prefix}.evidence kind is invalid`)
    requireString(evidence.reference, `${prefix}.evidence.reference`)
    requireString(evidence.outcome, `${prefix}.evidence.outcome`)
  }
  if (!Array.isArray(report.findings)) throw new Error(`Conductor run record ${prefix}.findings must be an array`)
  for (const [findingIndex, item] of report.findings.entries()) {
    const finding = asObject(item, `${prefix}.findings[${findingIndex}]`)
    requireString(finding.id, `${prefix}.findings.id`)
    if (!isOneOf(finding.severity, FINDING_SEVERITIES)) throw new Error(`Conductor run record ${prefix}.finding severity is invalid`)
    requireString(finding.description, `${prefix}.findings.description`)
    requireString(finding.impact, `${prefix}.findings.impact`)
  }
  requireStringArray(report.assumptions, `${prefix}.assumptions`)
  requireStringArray(report.blockers, `${prefix}.blockers`)
  requireStringArray(report.artifacts, `${prefix}.artifacts`)
  requireNormalizedStringArray(report.quality_evidence_ids, `${prefix}.quality_evidence_ids`, true)
  if (!Array.isArray(report.change_requests)) throw new Error(`Conductor run record ${prefix}.change_requests must be an array`)
  for (const [requestIndex, item] of report.change_requests.entries()) {
    const request = asObject(item, `${prefix}.change_requests[${requestIndex}]`)
    if (!isOneOf(request.target, CHANGE_TARGETS)) throw new Error(`Conductor run record ${prefix}.change request target is invalid`)
    requireString(request.reason, `${prefix}.change_requests.reason`)
    requireString(request.impact, `${prefix}.change_requests.impact`)
  }
  if (report.execution_baseline !== undefined) validateBaseline(report.execution_baseline)
  const transition = asObject(report.recommended_transition, `${prefix}.recommended_transition`)
  if (transition.target !== 'conductor') throw new Error(`Conductor run record ${prefix} must return to conductor`)
  requireString(transition.rationale, `${prefix}.recommended_transition.rationale`)
  if (!isOneOf(report.confidence, CONFIDENCES)) throw new Error(`Conductor run record ${prefix}.confidence is invalid`)
}

function validateDecision(value: unknown): void {
  const decision = asObject(value, 'decision')
  requireNormalizedString(decision.run_id, 'decision.run_id')
  if (!isOneOf(decision.decision, ARBITER_DECISIONS)) {
    throw new Error(`Conductor run record has invalid decision.decision: ${String(decision.decision)}`)
  }
  requireNormalizedStringArray(decision.basis, 'decision.basis')
  requireNormalizedStringArray(decision.evidence_reviewed, 'decision.evidence_reviewed')
  requireNormalizedStringArray(decision.conditions, 'decision.conditions')
  requireNormalizedStringArray(decision.open_risks, 'decision.open_risks')
  requireNormalizedStringArray(decision.required_follow_up, 'decision.required_follow_up')
  if (decision.decision === 'go'
    && (decision.basis.length === 0 || decision.evidence_reviewed.length === 0)) {
    throw new Error('Conductor run record Arbiter GO requires a non-empty basis and reviewed evidence')
  }
}

function validateTraceability(value: unknown, field: string): void {
  const traceability = asObject(value, field)
  requireNormalizedStringArray(traceability.mandate, `${field}.mandate`)
  requireNormalizedStringArray(traceability.baseline, `${field}.baseline`)
  requireNormalizedStringArray(traceability.changes, `${field}.changes`)
  requireNormalizedStringArray(traceability.verification, `${field}.verification`)
  requireNormalizedStringArray(traceability.decision, `${field}.decision`)
}

function validateCloseout(value: unknown): void {
  const closeout = asObject(value, 'closeout')
  requireNormalizedString(closeout.run_id, 'closeout.run_id')
  if (closeout.arbiter_decision !== 'go') throw new Error('Conductor run record closeout.arbiter_decision must be "go"')
  requireNormalizedString(closeout.authorized_by, 'closeout.authorized_by')
  if (!isOneOf(closeout.authorized_action, CLOSEOUT_ACTIONS)) {
    throw new Error(`Conductor run record has invalid closeout.authorized_action: ${String(closeout.authorized_action)}`)
  }
  requireNormalizedStringArray(closeout.actions_taken, 'closeout.actions_taken')
  requireNormalizedStringArray(closeout.outcome_evidence, 'closeout.outcome_evidence')
  requireNormalizedStringArray(closeout.unverified_items, 'closeout.unverified_items')
  requireNormalizedStringArray(closeout.open_risks, 'closeout.open_risks')
  if (closeout.outcome_evidence.length === 0) {
    throw new Error('Conductor run record closeout.outcome_evidence must not be empty')
  }
  if (!Array.isArray(closeout.follow_up)) throw new Error('Conductor run record closeout.follow_up must be an array')
  for (const [index, item] of closeout.follow_up.entries()) {
    const followUp = asObject(item, `closeout.follow_up[${index}]`)
    requireNormalizedString(followUp.owner, `closeout.follow_up[${index}].owner`)
    requireNormalizedString(followUp.due_condition, `closeout.follow_up[${index}].due_condition`)
  }
  validateTraceability(closeout.traceability, 'closeout.traceability')
  if (closeout.status !== 'closed') throw new Error('Conductor run record closeout.status must be "closed"')
}

/**
 * A keyed store of Conductor runs. Implementations may be in-memory (tests) or
 * durable (a storage backend or a session-log projection); the contract is
 * keyed by {@link ConductorRunId} and owns no gate semantics.
 */
export interface ConductorRunStore {
  /**
   * Persist one run under its {@link ConductorRun.runId}, replacing any
   * previous record for that id.
   * @param run - the run to persist.
   */
  save(run: ConductorRun): Promise<void>
  /**
   * Read a persisted run.
   * @param runId - the run id to read.
   * @returns the run, or undefined when no record exists for the id.
   */
  load(runId: ConductorRunId): Promise<ConductorRun | undefined>
  /**
   * Remove a persisted run. Idempotent: a missing id is a no-op.
   * @param runId - the run id to remove.
   */
  delete(runId: ConductorRunId): Promise<void>
}

/**
 * In-memory {@link ConductorRunStore} that round-trips each run through the
 * JSON wire format, so save/load exercise {@link serializeRun}/{@link parseRun}
 * and never alias a caller's live object.
 */
export class InMemoryConductorRunStore implements ConductorRunStore {
  private readonly records = new Map<string, string>()

  save(run: ConductorRun): Promise<void> {
    this.records.set(run.runId, serializeRun(run))
    return Promise.resolve()
  }

  load(runId: ConductorRunId): Promise<ConductorRun | undefined> {
    const json = this.records.get(runId)
    return Promise.resolve(json === undefined ? undefined : parseRun(json))
  }

  delete(runId: ConductorRunId): Promise<void> {
    this.records.delete(runId)
    return Promise.resolve()
  }
}

/**
 * Session-log-backed run store. Every save appends a whole-run checkpoint and
 * waits for the caller-supplied session flush, so a later process can fold the
 * same durable log without relying on live process memory.
 */
export class SessionConductorRunStore implements ConductorRunStore {
  /**
   * @param session - calling parent Session that owns the durable checkpoints.
   * @param flush - persists the Session through its configured backend.
   */
  constructor(
    private readonly session: Session,
    private readonly flush: () => Promise<void>,
  ) {}

  /**
   * Save owner facts before their complete checkpoint and flush both together.
   * @param run - exact owner-bound record to serialize.
   * @param transport - host response binding preserved for duplicate receipts.
   */
  async save(run: ConductorRun, transport?: OwnerTransportBinding): Promise<void> {
    if (run.ownerSessionId !== null && run.ownerSessionId !== this.session.id) {
      throw new Error('Conductor checkpoint belongs to another owning root session')
    }
    const record = serializeRun(run)
    publishOwnerInteractions(this.session, run, transport)
    this.session.append('conductor/checkpoint', { runId: run.runId, record })
    await this.flush()
  }

  load(runId: ConductorRunId): Promise<ConductorRun | undefined> {
    for (let index = this.session.events.length - 1; index >= 0; index -= 1) {
      const event = this.session.events[index]
      if (event?.type !== 'conductor/checkpoint' || event.data.runId !== runId) continue
      if (event.data.record === null) return Promise.resolve(undefined)
      const inspected = inspectRunRecord(runId, event.data.record, this.session.id)
      if (inspected.kind === 'unavailable') return Promise.reject(new ConductorRunUnavailableError(runId, inspected.format))
      const run = inspected.run
      return Promise.resolve(replayOwnerInteractions(run, this.session.events.slice(index + 1)))
    }
    return Promise.resolve(undefined)
  }

  async delete(runId: ConductorRunId): Promise<void> {
    this.session.append('conductor/checkpoint', { runId, record: null })
    await this.flush()
  }
}

/**
 * Serialize a run to its durable JSON form.
 * @param run - the run to serialize.
 * @returns the JSON string.
 */
export function serializeRun(run: ConductorRun): string {
  return JSON.stringify(run)
}

/**
 * Parse a durable JSON record back into a run. Every run field and nested
 * record used after resume is validated at this durable boundary; same-process
 * TypeScript types are not trusted after JSON persistence.
 * @param json - the serialized run.
 * @returns the parsed run.
 */
export function parseRun(json: string): ConductorRun {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (cause) {
    throw new Error('Conductor run record is not valid JSON', { cause })
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Conductor run record must be a JSON object')
  }
  const record = raw as Record<string, unknown>

  if (record.recordFormatVersion !== CONDUCTOR_RECORD_FORMAT_VERSION) {
    throw new Error(
      `Conductor run record format ${String(record.recordFormatVersion)} is unsupported; expected ${CONDUCTOR_RECORD_FORMAT_VERSION}`,
    )
  }
  const runKeys = ['recordFormatVersion', 'admission', 'repairReturns', 'analysisMode', 'analysisReports', 'reportCandidates', 'analysisChallenges', 'reportDecision',
    'runId', 'objective', 'scope', 'inputArtifacts', 'allowedPaths', 'excludedPaths', 'sourceBaseline', 'authority',
    'constraints', 'acceptanceCriteria', 'budget', 'baselineHistory', 'baseline', 'executionAuthorization', 'currentStage',
    'history', 'specialistReports', 'qualityExecutions', 'status', 'decision', 'closeout',
    'ownerSessionId', 'ownerCapabilities', 'ownerRevision', 'ownerLedger']
  if (Object.keys(record).some(key => !runKeys.includes(key))) throw new Error('Conductor run record contains unsupported phase-one fields')
  const admission = parseAdmission(record.admission)

  if (typeof record.runId !== 'string' || !isValidRunId(record.runId)) {
    throw new Error(`Conductor run record has invalid runId: ${String(record.runId)}`)
  }
  requireNormalizedString(record.objective, 'objective')
  requireNormalizedStringArray(record.scope, 'scope', true)
  requireNormalizedStringArray(record.inputArtifacts, 'inputArtifacts', true)
  requireNormalizedStringArray(record.allowedPaths, 'allowedPaths', true)
  requireNormalizedStringArray(record.excludedPaths, 'excludedPaths', true)
  if (record.sourceBaseline !== null) {
    requireNormalizedString(record.sourceBaseline, 'sourceBaseline')
  }
  const authority = asObject(record.authority, 'authority')
  if (Object.keys(authority).some(key => key !== 'owner')) {
    throw new Error('Conductor run record authority is attribution-only')
  }
  requireNormalizedString(authority.owner, 'authority.owner')
  requireNormalizedStringArray(record.constraints, 'constraints', true)
  requireNormalizedStringArray(record.acceptanceCriteria, 'acceptanceCriteria', true)
  requireAnalysisCriteria(admission, record.acceptanceCriteria)
  const budget = asObject(record.budget, 'budget')
  if (Object.keys(budget).some(key => !['maxReworkPerGate', 'maxRalphRounds', 'maxOwnerReassessmentsPerGate',
    'maxCriticInputTokensPerAttempt', 'maxCriticOutputTokensPerAttempt', 'maxCriticTokensPerRun'].includes(key))) {
    throw new Error('Conductor run record budget contains unsupported fields; a fresh run is required')
  }
  if (!Number.isSafeInteger(budget.maxReworkPerGate) || Number(budget.maxReworkPerGate) < 1) {
    throw new Error('Conductor run record budget.maxReworkPerGate must be a positive safe integer')
  }
  if (!Number.isSafeInteger(budget.maxRalphRounds) || Number(budget.maxRalphRounds) < 0) {
    throw new Error('Conductor run record budget.maxRalphRounds must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(budget.maxOwnerReassessmentsPerGate) || Number(budget.maxOwnerReassessmentsPerGate) < 1) {
    throw new Error('Conductor run record budget.maxOwnerReassessmentsPerGate must be a positive safe integer')
  }
  for (const field of ['maxCriticInputTokensPerAttempt', 'maxCriticOutputTokensPerAttempt', 'maxCriticTokensPerRun'] as const) {
    if (!Number.isSafeInteger(budget[field]) || Number(budget[field]) < 1) {
      throw new Error(`Conductor run record budget.${field} must be a positive safe integer`)
    }
  }
  if (Number(budget.maxCriticTokensPerRun)
    < Number(budget.maxCriticInputTokensPerAttempt) + Number(budget.maxCriticOutputTokensPerAttempt)) {
    throw new Error('Conductor run record critic budget cannot reserve one complete attempt')
  }
  if (!Array.isArray(record.history)) throw new Error('Conductor run record history must be an array')
  assertOwnerLedger(record as unknown as ConductorRun)
  if (admission.purpose === 'analysis') return parseAnalysisState(record)
  if (record.analysisMode !== null || !Array.isArray(record.analysisChallenges) || record.analysisChallenges.length !== 0
    || !Array.isArray(record.repairReturns) || record.repairReturns.length !== 0
    || !Array.isArray(record.analysisReports) || record.analysisReports.length !== 0
    || !Array.isArray(record.reportCandidates) || record.reportCandidates.length !== 0
    || record.reportDecision !== undefined) throw new Error('Implementation run cannot carry analysis report state')
  if (!Array.isArray(record.baselineHistory)) {
    throw new Error('Conductor run record baselineHistory must be an array')
  }
  const baselineHashes: string[] = []
  for (const [index, value] of record.baselineHistory.entries()) {
    validateBaseline(value, `baselineHistory[${index}]`)
    const hash = executionBaselineHash(value as ConductorRun['baseline'] & {})
    baselineHashes.push(hash)
  }
  validateBaseline(record.baseline)
  const mandate = effectiveOwnerMandate(record as unknown as ConductorRun)
  if (record.baseline !== null) {
    const baseline = record.baseline as Record<string, unknown>
    if ((record.baseline as ExecutionBaseline).qualityCommands
      .some(binding => !ownerCommandAllowed(record as unknown as ConductorRun, binding.id))) {
      throw new Error('Conductor run record active baseline command exceeds the effective owner mandate')
    }
    if (JSON.stringify(baseline.allowedPaths) !== JSON.stringify(mandate.allowedPaths)
      || JSON.stringify(baseline.excludedPaths) !== JSON.stringify(mandate.excludedPaths)) {
      throw new Error('Conductor run record baseline paths must match the owner-authorized run paths')
    }
    const activeHash = executionBaselineHash(record.baseline as ConductorRun['baseline'] & {})
    if (!baselineHashes.includes(activeHash) || activeHash !== baselineHashes.at(-1)) {
      throw new Error('Conductor run record active baseline must be the latest baselineHistory entry')
    }
  }
  if (record.executionAuthorization === null) {
    if (record.baseline !== null) throw new Error('Conductor run record active baseline requires executionAuthorization')
  } else {
    if (record.baseline === null) throw new Error('Conductor run record executionAuthorization requires an active baseline')
    const authorization = asObject(record.executionAuthorization, 'executionAuthorization')
    const exactKeys = new Set(['executionBaselineHash', 'effectProfile'])
    for (const key of Object.keys(authorization)) {
      if (!exactKeys.has(key)) throw new Error(`Conductor run record executionAuthorization contains unsupported field ${key}`)
    }
    const activeBaseline = record.baseline as ConductorRun['baseline'] & {}
    const activeHash = executionBaselineHash(activeBaseline)
    if (authorization.executionBaselineHash !== activeHash) {
      throw new Error('Conductor run record executionAuthorization does not match active baseline')
    }
    const effectProfile = asObject(authorization.effectProfile, 'executionAuthorization.effectProfile')
    const requiredProfile = executionEffectProfile(activeBaseline)
    if (Object.keys(effectProfile).length !== 3
      || effectProfile.filesystem !== requiredProfile.filesystem
      || effectProfile.quality !== requiredProfile.quality
      || effectProfile.external !== requiredProfile.external) {
      throw new Error('Conductor run record executionAuthorization has an invalid effect profile')
    }
  }
  if (!isOneOf(record.status, RUN_STATUSES)) {
    throw new Error(`Conductor run record has invalid status: ${String(record.status)}`)
  }
  if (!isOneOf(record.currentStage, STAGES)) {
    throw new Error(`Conductor run record has invalid currentStage: ${String(record.currentStage)}`)
  }
  const reworksPerGate = new Map<GateId, number>()
  for (const entry of record.history) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('Conductor run history entry must be an object')
    }
    const gate = entry as Record<string, unknown>
    if (gate.kind === 'skipped') continue
    if (gate.kind !== 'evaluated') throw new Error('Conductor gate record requires evaluated or skipped kind')
    if (!isOneOf(gate.gate, GATE_IDS)) {
      throw new Error(`Conductor gate record has invalid gate: ${String(gate.gate)}`)
    }
    if (!isOneOf(gate.stage, STAGES)) {
      throw new Error(`Conductor gate record has invalid stage: ${String(gate.stage)}`)
    }
    if (!isOneOf(gate.decision, GATE_DECISIONS)) {
      throw new Error(`Conductor gate record has invalid decision: ${String(gate.decision)}`)
    }
    if (gate.defectClass !== undefined && !isOneOf(gate.defectClass, DEFECT_CLASSES)) {
      throw new Error(`Conductor gate record has invalid defectClass: ${JSON.stringify(gate.defectClass)}`)
    }
    if (gate.nextStage !== undefined && !isOneOf(gate.nextStage, STAGES)) {
      throw new Error(`Conductor gate record has invalid nextStage: ${JSON.stringify(gate.nextStage)}`)
    }
    requireStringArray(gate.basis, 'history.basis')
    requireStringArray(gate.evidenceReviewed, 'history.evidenceReviewed')
    requireString(gate.stateUpdate, 'history.stateUpdate')
    if (GATE_STAGE[gate.gate] !== gate.stage) {
      throw new Error(`Conductor gate ${gate.gate} cannot belong to stage ${gate.stage}`)
    }
    if (gate.decision === 'rework') {
      if (!isOneOf(gate.defectClass, DEFECT_CLASSES)
        || gate.nextStage !== (gate.defectClass === 'report' ? gate.stage : REWORK_STAGE[gate.defectClass])) {
        throw new Error(`Conductor gate ${gate.gate} rework has invalid defectClass or nextStage`)
      }
      const count = (reworksPerGate.get(gate.gate) ?? 0) + 1
      if (count > Number(budget.maxReworkPerGate)) {
        throw new Error(`Conductor gate ${gate.gate} exceeds its per-gate rework budget`)
      }
      reworksPerGate.set(gate.gate, count)
    }
    if (gate.decision === 'abort' && (gate.nextStage !== undefined || gate.defectClass !== undefined)) {
      throw new Error(`Conductor gate ${gate.gate} abort cannot carry rework routing`)
    }
    const requiresBaselineHash = (gate.gate === 'C' && gate.decision === 'pass')
      || gate.gate === 'D' || gate.gate === 'E' || gate.gate === 'F' || gate.gate === 'G'
    if (requiresBaselineHash) {
      const hash = requireString(gate.executionBaselineHash, `history Gate ${gate.gate} executionBaselineHash`)
      if (!/^[a-f0-9]{64}$/.test(hash) || !baselineHashes.includes(hash)) {
        throw new Error(`Conductor gate ${gate.gate} references an unknown execution baseline`)
      }
    } else if (gate.executionBaselineHash !== undefined) {
      throw new Error(`Conductor gate ${gate.gate} cannot carry executionBaselineHash`)
    }
  }
  const gateCBaselineHashes = record.history
    .filter(entry => (entry as Record<string, unknown>).gate === 'C'
      && (entry as Record<string, unknown>).decision === 'pass')
    .map(entry => (entry as Record<string, unknown>).executionBaselineHash)
  if (JSON.stringify(gateCBaselineHashes) !== JSON.stringify(baselineHashes)) {
    throw new Error('Conductor run record baselineHistory must exactly follow Gate C pass history')
  }
  const amendmentPositions = new Set((record.ownerLedger as ConductorRun['ownerLedger'])
    .filter(entry => entry.kind === 'answer' && entry.proposalHash !== undefined)
    .map(entry => entry.historyLength))
  let documentedBaselineHash: string | undefined
  for (const [index, entry] of record.history.entries()) {
    if (amendmentPositions.has(index)) {
      documentedBaselineHash = undefined
    }
    const gate = entry as Record<string, unknown>
    if (gate.gate === 'C' && gate.decision === 'pass') {
      documentedBaselineHash = gate.executionBaselineHash as string
      continue
    }
    if (gate.gate === 'D' || gate.gate === 'E' || gate.gate === 'F' || gate.gate === 'G') {
      if (gate.executionBaselineHash !== documentedBaselineHash) {
        throw new Error(`Conductor gate ${gate.gate} does not use the latest Gate C baseline`)
      }
      if (gate.decision === 'rework' && (gate.defectClass === 'scope' || gate.defectClass === 'plan')) {
        documentedBaselineHash = undefined
      }
    }
  }
  if (amendmentPositions.has(record.history.length)) {
    documentedBaselineHash = undefined
  }
  const activeBaselineHash = record.baseline === null
    ? undefined
    : executionBaselineHash(record.baseline as ExecutionBaseline)
  if (activeBaselineHash !== documentedBaselineHash) {
    throw new Error('Conductor run record active baseline does not match documented gate lineage')
  }

  if (!Array.isArray(record.specialistReports)) {
    throw new Error('Conductor run record specialistReports must be an array')
  }
  for (const [index, report] of record.specialistReports.entries()) {
    validateSpecialistReport(report, index, record.runId)
  }

  if (!Array.isArray(record.qualityExecutions)) {
    throw new Error('Conductor run record qualityExecutions must be an array')
  }
  const qualityIds = new Set<string>()
  const baselineHistory = record.baselineHistory as ConductorRun['baselineHistory']
  for (const [index, value] of record.qualityExecutions.entries()) {
    const prefix = `qualityExecutions[${index}]`
    const item = asObject(value, prefix)
    const exactKeys = new Set([
      'evidenceId', 'runId', 'childSessionId', 'commandId', 'definitionHash', 'executionBaselineHash',
      'gate', 'cycle', 'policyStage', 'executorStage', 'outcome', 'failure', 'exitCode', 'signal',
      'startedAt', 'finishedAt', 'stdoutSha256', 'stderrSha256', 'stdoutTruncated', 'stderrTruncated',
    ])
    for (const key of Object.keys(item)) {
      if (!exactKeys.has(key)) throw new Error(`Conductor run record ${prefix} contains unsupported field ${key}`)
    }
    const evidenceId = requireNormalizedString(item.evidenceId, `${prefix}.evidenceId`)
    if (qualityIds.has(evidenceId)) throw new Error('Conductor run record quality evidence ids must not contain duplicates')
    qualityIds.add(evidenceId)
    if (item.runId !== record.runId) throw new Error(`Conductor run record ${prefix}.runId must match runId`)
    requireNormalizedString(item.childSessionId, `${prefix}.childSessionId`)
    const commandId = requireNormalizedString(item.commandId, `${prefix}.commandId`)
    const definitionHash = requireString(item.definitionHash, `${prefix}.definitionHash`)
    if (!/^[a-f0-9]{64}$/.test(definitionHash)) throw new Error(`Conductor run record ${prefix}.definitionHash must be SHA-256`)
    const evidenceBaselineHash = requireString(item.executionBaselineHash, `${prefix}.executionBaselineHash`)
    const evidenceBaseline = baselineHistory.find(candidate => executionBaselineHash(candidate) === evidenceBaselineHash)
    if (evidenceBaseline === undefined) throw new Error(`Conductor run record ${prefix} references an unknown baseline`)
    const binding = evidenceBaseline.qualityCommands.find(candidate => candidate.id === commandId)
    if (binding?.definitionHash !== definitionHash) throw new Error(`Conductor run record ${prefix} does not match a baseline binding`)
    if (item.gate !== 'D' && item.gate !== 'E') throw new Error(`Conductor run record ${prefix}.gate is invalid`)
    if (!Number.isSafeInteger(item.cycle) || Number(item.cycle) < 1) throw new Error(`Conductor run record ${prefix}.cycle is invalid`)
    const completedCycles = record.history.filter((entry) => {
      const gate = entry as Record<string, unknown>
      return gate.gate === item.gate && gate.executionBaselineHash === evidenceBaselineHash
    }).length
    if (Number(item.cycle) > completedCycles) throw new Error(`Conductor run record ${prefix}.cycle has no documented gate attempt`)
    if (!isOneOf(item.policyStage, QUALITY_POLICY_STAGES)) throw new Error(`Conductor run record ${prefix}.policyStage is invalid`)
    if (!isOneOf(item.executorStage, QUALITY_EXECUTOR_STAGES)) throw new Error(`Conductor run record ${prefix}.executorStage is invalid`)
    if ((item.gate === 'D' && item.policyStage !== 'headsman') || (item.gate === 'E' && item.policyStage !== 'auditor')) {
      throw new Error(`Conductor run record ${prefix} stage does not match gate`)
    }
    if ((item.policyStage === 'auditor' && item.executorStage !== 'auditor')
      || (item.policyStage === 'headsman' && item.executorStage === 'auditor')) {
      throw new Error(`Conductor run record ${prefix} executorStage is outside the policy stage`)
    }
    if (item.outcome !== 'passed' && item.outcome !== 'failed') throw new Error(`Conductor run record ${prefix}.outcome is invalid`)
    if (item.outcome === 'failed' && !isOneOf(item.failure, QUALITY_FAILURES)) throw new Error(`Conductor run record ${prefix}.failure is invalid`)
    if (item.outcome === 'passed' && item.failure !== undefined) throw new Error(`Conductor run record ${prefix} passed with a failure`)
    if (item.exitCode !== null && !Number.isInteger(item.exitCode)) throw new Error(`Conductor run record ${prefix}.exitCode is invalid`)
    if (item.signal !== null && typeof item.signal !== 'string') throw new Error(`Conductor run record ${prefix}.signal is invalid`)
    if (item.outcome === 'passed' && (item.exitCode !== 0 || item.signal !== null)) {
      throw new Error(`Conductor run record ${prefix} passed without a clean exit`)
    }
    if (item.failure === 'signal' && (typeof item.signal !== 'string' || item.signal.length === 0)) {
      throw new Error(`Conductor run record ${prefix} signal failure requires a signal`)
    }
    const startedAt = requireIsoTimestamp(item.startedAt, `${prefix}.startedAt`)
    const finishedAt = requireIsoTimestamp(item.finishedAt, `${prefix}.finishedAt`)
    if (finishedAt < startedAt) throw new Error(`Conductor run record ${prefix} finished before it started`)
    for (const field of ['stdoutSha256', 'stderrSha256'] as const) {
      if (!/^[a-f0-9]{64}$/.test(requireString(item[field], `${prefix}.${field}`))) {
        throw new Error(`Conductor run record ${prefix}.${field} must be SHA-256`)
      }
    }
    if (typeof item.stdoutTruncated !== 'boolean' || typeof item.stderrTruncated !== 'boolean') {
      throw new Error(`Conductor run record ${prefix} truncation flags must be booleans`)
    }
  }
  for (const [index, value] of record.specialistReports.entries()) {
    const report = value as Record<string, unknown>
    for (const evidenceId of report.quality_evidence_ids as string[]) {
      if (!qualityIds.has(evidenceId)) {
        throw new Error(`Conductor run record specialistReports[${index}] references unknown quality evidence`)
      }
    }
  }
  validatePassedQualityGates(record as unknown as ConductorRun)

  if (record.decision !== undefined) validateDecision(record.decision)
  if (record.closeout !== undefined) validateCloseout(record.closeout)
  const decision = record.decision as Record<string, unknown> | undefined
  const closeout = record.closeout as Record<string, unknown> | undefined
  if (decision !== undefined && decision.run_id !== record.runId) {
    throw new Error('Conductor run record decision.run_id must match runId')
  }
  if (closeout !== undefined && closeout.run_id !== record.runId) {
    throw new Error('Conductor run record closeout.run_id must match runId')
  }
  if (closeout !== undefined && closeout.authorized_by !== authority.owner) {
    throw new Error('Conductor run record closeout.authorized_by must match authority.owner')
  }
  if (record.status === 'awaiting_authorization'
    && (record.currentStage !== 'closeout' || decision?.decision !== 'go')) {
    throw new Error('Conductor run awaiting authorization requires closeout stage and an Arbiter GO')
  }
  if (record.status === 'closed'
    && (record.currentStage !== 'closeout' || decision?.decision !== 'go' || closeout === undefined)) {
    throw new Error('Closed Conductor run requires closeout stage, Arbiter GO, and closeout record')
  }
  const lastGate = record.history.findLast(entry => (entry as Record<string, unknown>).kind === 'evaluated') as Record<string, unknown> | undefined
  if (lastGate !== undefined) {
    const expectedStatus = lastGate.decision === 'pass'
      ? (lastGate.gate === 'G' ? 'awaiting_authorization' : 'running')
      : lastGate.decision === 'rework'
        ? 'rework'
        : lastGate.decision === 'escalate'
          ? 'escalated'
          : 'aborted'
    const ownerStatus = ownerLifecycleStatus(record as unknown as ConductorRun)
    if (record.status !== (ownerStatus ?? expectedStatus) && !(record.status === 'closed' && expectedStatus === 'awaiting_authorization')) {
      throw new Error(`Conductor run record status ${record.status} does not match last gate decision`)
    }
  }

  validateIntakeHistory(record as unknown as ConductorRun)
  return record as unknown as ConductorRun
}

/**
 * Assert a run is resumable. A `closed` or `aborted` run is terminal and never
 * resumes. A resumable run must sit exactly where its documented history put
 * it: skipped gates and causal repairs must follow the admitted profile;
 * every history entry must continue from its predecessor and
 * `currentStage` must equal the last documented successor.
 * @param run - the run to check.
 */
export function validateResumable(run: ConductorRun): void {
  if (run.status === 'closed' || run.status === 'aborted' || run.status === 'reported') {
    throw new Error(`Conductor run ${run.runId} is ${run.status}; a terminal run cannot resume`)
  }
  if (run.status === 'escalated') {
    throw new Error(`Conductor run ${run.runId} is escalated; an owner resolution is required before resume`)
  }
  if (run.status === 'awaiting_owner' || run.status === 'continuation_pending') {
    throw new Error(`Conductor run ${run.runId} is ${run.status}; owner resumption requires an exact host reservation`)
  }
  assertOwnerLedger(run)
  validateIntakeHistory(run)
}

/**
 * Load a run and return it only if it is resumable.
 * @param store - the store to read from.
 * @param runId - the run id to resume.
 * @returns the run at its last documented, valid state.
 */
export async function resumeRun(store: ConductorRunStore, runId: ConductorRunId): Promise<ConductorRun> {
  const run = await store.load(runId)
  if (run === undefined) {
    throw new Error(`Conductor run ${runId} not found; cannot resume`)
  }
  validateResumable(run)
  const last = run.ownerLedger.at(-1)
  if (last?.kind === 'consumed' && last.historyLength === run.history.length) {
    throw new Error(`Conductor run ${runId} has an ambiguous consumed owner dispatch; it remains parked and will not dispatch again`)
  }
  return run
}
