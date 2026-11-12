/** Validated phase-one intake and captured, versioned source material. */
import { createHash } from 'node:crypto'
import type { ConductorAdmission, ConductorEntry, ConductorMaterialId, ConductorRun, ConductorStage, DefectClass, GateDecision, IntakeMaterial, RepairReturn } from './types.ts'

/** Phase-one entries; selecting one never grants execution authority. */
export const CONDUCTOR_ENTRIES = ['detective', 'strategist', 'devils-advocate'] as const

/**
 * Require measurable deliverable criteria before admitting or restoring an analysis.
 * @param admission - validated purpose and entry.
 * @param criteria - owner-task acceptance criteria to validate.
 */
export function requireAnalysisCriteria(admission: ConductorAdmission, criteria: readonly string[]): void {
  if (admission.purpose !== 'analysis') return
  if (criteria.length === 0) {
    throw new Error('Conductor analysis requires at least one acceptanceCriteria item. Put measurable deliverable requirements in acceptanceCriteria, not constraints.')
  }
  if (criteria.some(criterion => criterion.length === 0 || criterion !== criterion.trim())) {
    throw new Error('Conductor analysis acceptanceCriteria must contain only non-empty normalized strings')
  }
  if (new Set(criteria).size !== criteria.length) throw new Error('Conductor analysis acceptanceCriteria must not contain duplicates')
}

/**
 * Hash exact UTF-8 text or canonical JSON selected by its owner.
 * @param text - complete input, without trimming or truncation.
 * @returns lowercase SHA-256.
 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Capture one host-read input with a deterministic, selector-bound identity.
 * @param selector - current-request or a workspace-relative file path.
 * @param content - complete captured UTF-8 content.
 * @param sourceMessage - host-owned parent event identity for current-request; absent for files.
 * @returns the immutable input projection to persist before dispatch.
 */
export function captureIntakeMaterial(selector: string, content: string, sourceMessage?: IntakeMaterial['sourceMessage']): IntakeMaterial {
  return {
    id: `material-${contentHash(`${selector}\0${content}`)}` as ConductorMaterialId,
    selector,
    kind: selector === 'current-request' ? 'current-request' : 'file',
    content,
    sha256: contentHash(content),
    ...sourceMessage === undefined ? {} : { sourceMessage },
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Conductor intake must be an object')
  return value as Record<string, unknown>
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() !== item || !item)
    || new Set(value).size !== value.length) throw new Error(`Conductor intake ${field} must contain distinct non-empty strings`)
  return value as string[]
}

function selection(value: Record<string, unknown>) {
  if (value.purpose !== 'implementation' && value.purpose !== 'analysis') {
    throw new Error('Conductor purpose must be implementation or analysis; verification is not supported in phase 1')
  }
  if (!(CONDUCTOR_ENTRIES as readonly unknown[]).includes(value.entry)) {
    throw new Error('Conductor entry must be detective, strategist or devils-advocate; Auditor entry is not supported in phase 1')
  }
  const entry = value.entry as ConductorEntry
  if (value.purpose === 'implementation') {
    if (value.deliverable !== undefined) throw new Error('Conductor implementation must not specify deliverable')
    return { purpose: 'implementation' as const, entry }
  }
  if (value.deliverable !== 'answer' && value.deliverable !== 'recommendations') {
    throw new Error('Conductor analysis deliverable must be answer or recommendations')
  }
  return { purpose: 'analysis' as const, entry, deliverable: value.deliverable }
}

/**
 * Admit model-proposed choices against host-captured inputs.
 * @param input - tool JSON fields; material references use selectors, never guessed ids.
 * @param materials - complete host-captured current request and explicitly cited files.
 * @returns validated immutable choices and their captured provenance.
 */
export function admitIntake(input: unknown, materials: readonly IntakeMaterial[]): ConductorAdmission {
  const value = object(input)
  const keys = ['purpose', 'entry', 'deliverable', 'rationale', 'scopeSources', 'plan', 'planSources']
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Conductor intake contains unsupported phase-one fields')
  if (typeof value.rationale !== 'string' || !value.rationale.trim() || value.rationale !== value.rationale.trim()) {
    throw new Error('Conductor intake rationale must be a non-empty string')
  }
  const resolve = (refs: unknown, field: string): ConductorMaterialId[] => strings(refs, field).map((ref) => {
    const found = materials.find(material => material.selector === ref)
    if (found === undefined) throw new Error(`Conductor intake ${field} cites unknown material ${ref}`)
    return found.id
  })
  return parseAdmission({
    ...selection(value), profileVersion: 1, rationale: value.rationale,
    materials: structuredClone(materials),
    scopeSources: resolve(value.scopeSources ?? [], 'scopeSources'),
    plan: strings(value.plan ?? [], 'plan'),
    planSources: resolve(value.planSources ?? [], 'planSources'),
  })
}

/**
 * Validate captured admission at the durable JSON parser.
 * @param input - persisted admission, including contents and hashes.
 * @returns the validated admission; incompatible/forged fields throw.
 */
export function parseAdmission(input: unknown): ConductorAdmission {
  const value = object(input)
  const chosen = selection(value)
  const keys = ['purpose', 'entry', 'deliverable', 'profileVersion', 'rationale', 'materials', 'scopeSources', 'plan', 'planSources']
  if (value.profileVersion !== 1 || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('Conductor intake has an unsupported profile version or fields')
  }
  if (typeof value.rationale !== 'string' || !value.rationale.trim() || value.rationale.trim() !== value.rationale) {
    throw new Error('Conductor intake requires a normalized rationale')
  }
  if (!Array.isArray(value.materials) || value.materials.length === 0) throw new Error('Conductor intake requires captured material')
  const selectors = new Set<string>()
  const ids = new Set<string>()
  for (const [index, raw] of value.materials.entries()) {
    const material = object(raw)
    if (Object.keys(material).some(key => !['id', 'selector', 'kind', 'content', 'sha256', 'sourceMessage'].includes(key))
      || typeof material.selector !== 'string' || !material.selector || selectors.has(material.selector)
      || typeof material.content !== 'string' || !material.content.trim()) throw new Error('Conductor intake material is invalid or duplicated')
    if (index === 0 ? material.selector !== 'current-request' || material.kind !== 'current-request'
      : material.kind !== 'file' || material.selector === 'current-request'
        || material.selector.includes('\\') || material.selector.startsWith('/') || material.selector.includes(':')
        || material.selector.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Conductor intake requires the current request followed by workspace-relative files')
    }
    if (index === 0) {
      const source = object(material.sourceMessage)
      if (Object.keys(source).some(key => !['sessionId', 'eventIndex'].includes(key))
        || typeof source.sessionId !== 'string' || !source.sessionId || !Number.isSafeInteger(source.eventIndex)
        || Number(source.eventIndex) < 0) throw new Error('Conductor current-request requires actual user-message provenance')
    } else if (material.sourceMessage !== undefined) throw new Error('Conductor file material cannot claim user-message provenance')
    const captured = captureIntakeMaterial(material.selector, material.content, material.sourceMessage as IntakeMaterial['sourceMessage'])
    if (captured.id !== material.id || captured.sha256 !== material.sha256) throw new Error('Conductor intake material hash or identity mismatch')
    selectors.add(material.selector)
    ids.add(captured.id)
  }
  for (const field of ['scopeSources', 'planSources'] as const) {
    if (strings(value[field], field).some(id => !ids.has(id))) throw new Error(`Conductor intake ${field} contains a dangling material id`)
  }
  strings(value.plan, 'plan')
  return { ...value, ...chosen } as ConductorAdmission
}

/**
 * Derive the complete profile path; supplied work selects entry, never authority.
 * @param admission - validated immutable admission.
 * @returns ordered gated stages for this purpose and deliverable.
 */
export function admittedRoute(admission: ConductorAdmission): ConductorStage[] {
  if (admission.purpose === 'implementation') {
    return ['detective', 'strategist', 'devils-advocate', 'headsman', 'auditor', 'integrator', 'arbiter']
  }
  return admission.entry === 'detective' && admission.deliverable === 'recommendations'
    ? ['detective', 'strategist', 'devils-advocate', 'auditor', 'arbiter']
    : admission.entry === 'devils-advocate'
      ? ['devils-advocate', 'auditor', 'arbiter']
      : [admission.entry, 'devils-advocate', 'auditor', 'arbiter']
}

/** Canonical gate order; report profiles explicitly record inapplicable stages as skips. */
export const GATED_STAGES = ['detective', 'strategist', 'devils-advocate', 'headsman', 'auditor', 'integrator', 'arbiter'] as const

/**
 * Identify the role owning an analysis report, including the required planning stage.
 * @param admission - admitted immutable choices.
 * @returns the producer, never a write-capable stage.
 */
export function reportProducer(admission: ConductorAdmission): ConductorEntry {
  return admission.purpose === 'analysis' && admission.entry === 'detective' && admission.deliverable === 'recommendations'
    ? 'strategist' : admission.entry
}

/**
 * Resolve causal routing for live transitions and durable-history validation.
 * @param run - current immutable admission, stage and pending repair returns.
 * @param decision - runtime decision, after per-gate budget enforcement.
 * @param defect - defect class for rework.
 * @param target - runtime-selected repair or escalation target.
 * @returns final successor and pending returns; callers record intervening skips separately.
 */
export function transitionRoute(
  run: Pick<ConductorRun, 'admission' | 'analysisMode' | 'currentStage' | 'repairReturns'>,
  decision: GateDecision,
  defect?: DefectClass,
  target?: ConductorStage,
): { nextStage: ConductorStage | undefined; repairReturns: RepairReturn[] } {
  const repairReturns = [...run.repairReturns]
  const analysis = run.admission.purpose === 'analysis'
  if (analysis && ['headsman', 'ralph', 'integrator', 'closeout'].includes(run.currentStage)) {
    throw new Error('Conductor analysis cannot enter an execution stage')
  }
  if (analysis && target !== undefined && ['headsman', 'ralph', 'integrator', 'closeout'].includes(target)) {
    throw new Error('Conductor analysis cannot route into execution')
  }
  if (decision === 'pass') {
    const pending = repairReturns.at(-1)
    if (pending?.stage === run.currentStage) {
      repairReturns.pop()
      return { nextStage: pending.returnTo, repairReturns }
    }
    const route = admittedRoute(run.admission)
    const index = route.indexOf(run.currentStage)
    if (index < 0) throw new Error('Conductor stage is outside its admitted route and has no repair return')
    return { nextStage: route[index + 1] ?? (analysis ? 'report-complete' : 'closeout'), repairReturns }
  }
  if (decision !== 'rework') return { nextStage: decision === 'abort' ? undefined : target, repairReturns }
  if (target === undefined || defect === undefined) throw new Error('Conductor rework requires a defect class and target')
  if (defect === 'report' && target !== run.currentStage
    && !(analysis && run.currentStage === 'devils-advocate' && run.analysisMode === 'critic'
      && target === reportProducer(run.admission))) {
    throw new Error('Conductor report rework must return to its reporting stage')
  }
  if (defect === 'scope' && target !== 'detective') throw new Error('Conductor scope rework must return to Detective')
  if (defect === 'plan' && target !== 'strategist') throw new Error('Conductor plan rework must return to Strategist')
  if (defect === 'analysis' && (!analysis || !['auditor', 'arbiter'].includes(run.currentStage)
    || target !== reportProducer(run.admission))) throw new Error('Conductor analysis rework must return to its report producer')
  if (analysis && (!['detective', 'strategist', 'devils-advocate', 'auditor', 'arbiter'].includes(target)
    || defect === 'implementation' || defect === 'delivery')) throw new Error('Conductor analysis cannot rework into execution')
  if (target !== run.currentStage && analysis) {
    const producer = reportProducer(run.admission)
    const admittedPrerequisites = admittedRoute(run.admission)
      .filter((stage): stage is ConductorEntry => ['detective', 'strategist', 'devils-advocate'].includes(stage))
    const prerequisites = admittedPrerequisites.includes(target as ConductorEntry)
      ? admittedPrerequisites : ['detective', 'strategist', 'devils-advocate'] as ConductorEntry[]
    const from = ['auditor', 'arbiter'].includes(run.currentStage) ? producer : run.currentStage
    const first = prerequisites.indexOf(target as ConductorEntry)
    const last = prerequisites.indexOf(from as ConductorEntry)
    if (first < 0 || last < 0 || first > last) throw new Error('Conductor analysis rework target is not an earlier prerequisite')
    let returnTo: ConductorStage = run.currentStage === 'auditor' || run.currentStage === 'arbiter'
      ? 'devils-advocate' : run.currentStage
    if (run.currentStage === 'arbiter') {
      repairReturns.push({ stage: 'auditor', returnTo: 'arbiter' })
    }
    for (let index = last; index >= first; index--) {
      const stage = prerequisites[index] as ConductorEntry
      if (stage !== returnTo) repairReturns.push({ stage, returnTo })
      returnTo = stage
    }
  }
  return { nextStage: target, repairReturns }
}
