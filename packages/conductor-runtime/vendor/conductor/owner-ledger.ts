/**
 * Pure, durable P1 owner interactions, without production scheduling or a controller.
 * @module @deepseek-ai/dsh-conductor/owner-ledger
 */
import { z } from 'zod'
import { contentHash, reportProducer, transitionRoute } from './intake.ts'
import { executionBaselineHash } from './quality.ts'
import type { ConductorRun, ConductorStage, GateId, GateRecord, RepairReturn, SpecialistProblem } from './types.ts'
import type { OwnerEscalation, OwnerInteraction, OwnerMandate, OwnerQuestion, OwnerQuestionItem, OwnerQuestionSource, OwnerResumePlan, ScriptedOwnerResponse } from './owner-types.ts'

/**
 * Classify an exhausted structural repair without making authority violations answerable.
 * @param problem - driver-validated problem after the automatic repair budget is exhausted.
 * @returns a recoverable report classification, or no owner continuation for an authority violation.
 */
export function ownerEscalationForProblem(problem: SpecialistProblem): OwnerEscalation | undefined {
  return problem.kind === 'report' ? { kind: 'recoverable', cause: 'rework-exhausted', reason: problem.message } : undefined
}

const text = z.string().min(1).max(8192).refine(value => value === value.trim())
const identity = text.max(256)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const stage = z.enum(['detective', 'strategist', 'devils-advocate', 'headsman', 'auditor', 'integrator', 'arbiter'])
const gate = z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G'])
const distinct = z.array(text).refine(values => new Set(values).size === values.length)
const mandateSchema = z.object({ allowedPaths: distinct, excludedPaths: distinct, qualityCommandIds: distinct }).strict()
const itemSchema = z.object({ id: identity, prompt: text, options: distinct }).strict()
const scriptedSourceSchema = z.looseObject({ source: z.enum(['scripted-test-provider', 'host-ui']) })
const questionSchema = z.object({
  id: identity, runId: identity, rootSessionId: identity, gateIndex: count, historyLength: count,
  stage, sourceKind: z.literal('child'), childId: identity, attempt: count.positive(),
  reportHash: hash, report: z.json(), mandateRevision: count,
  mandateHash: hash, baselineHash: hash.nullable(), cause: z.enum(['clarification', 'authority-amendment', 'rework-exhausted']),
  reason: text, items: z.array(itemSchema).max(32), proposal: mandateSchema.optional(),
}).strict()
const answerSchema = z.object({ itemId: identity, text, optionId: identity.optional() }).strict()
const planSchema = z.object({ id: identity, questionId: identity, gateIndex: count, gate, stage, mandateRevision: count }).strict()
const position = { revision: count.positive(), previousRevision: count, historyLength: count }
const ledgerSchema = z.array(z.discriminatedUnion('kind', [
  z.object({ ...position, kind: z.literal('question'), question: questionSchema }).strict(),
  z.object({ ...position, kind: z.literal('answer'), questionId: identity, action: z.enum(['approve', 'answer_continue']),
    answers: z.array(answerSchema), proposalHash: hash.optional(), plan: planSchema }).strict(),
  z.object({ ...position, kind: z.literal('consumed'), questionId: identity, planId: identity }).strict(),
  z.object({ ...position, kind: z.literal('rejected'), questionId: identity }).strict(),
]))

/**
 * Decode one required owner-interaction event without granting any authority.
 * @param value - untrusted event payload from storage or transport.
 * @returns a structurally valid interaction; run reconstruction checks causality.
 */
export function parseOwnerInteraction(value: unknown): OwnerInteraction {
  return ledgerSchema.element.parse(value) as OwnerInteraction
}
const gateByStage: Partial<Record<ConductorStage, GateId>> = {
  detective: 'A', strategist: 'B', 'devils-advocate': 'C', headsman: 'D', auditor: 'E', integrator: 'F', arbiter: 'G',
}

function fail(reason: string): never { throw new Error(`Conductor owner ledger: ${reason}`) }
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }

/**
 * Hash one concrete capability-validated mandate preview; free text is excluded.
 * @param mandate - exact machine-readable preview.
 * @returns stable SHA-256 binding the previewed paths and command identities.
 */
export function ownerMandateHash(mandate: OwnerMandate): string {
  return contentHash(JSON.stringify(mandateSchema.parse(mandate)))
}

function originalMandate(run: ConductorRun): OwnerMandate {
  return { allowedPaths: [...run.allowedPaths], excludedPaths: [...run.excludedPaths], qualityCommandIds: [] }
}

/**
 * Derive effective authority without overwriting intake or historical baselines.
 * @param run - validated durable run.
 * @returns an independent projection of the latest accepted mandate.
 */
export function effectiveOwnerMandate(run: ConductorRun): OwnerMandate {
  let mandate = originalMandate(run)
  for (const entry of run.ownerLedger) {
    if (entry.kind === 'answer' && entry.proposalHash !== undefined) {
      const question = run.ownerLedger.find(item => item.kind === 'question' && item.question.id === entry.questionId)
      if (question?.kind === 'question' && question.question.proposal !== undefined) mandate = structuredClone(question.question.proposal)
    }
  }
  return mandate
}

/**
 * Keep the original host catalog policy until an explicit amendment narrows command IDs.
 * @param run - validated run with its append-only owner mandate history.
 * @param id - host catalog command identity selected for a new baseline.
 * @returns whether the effective owner mandate permits this command identity.
 */
export function ownerCommandAllowed(run: ConductorRun, id: string): boolean {
  return !run.ownerLedger.some(entry => entry.kind === 'answer' && entry.proposalHash !== undefined)
    || effectiveOwnerMandate(run).qualityCommandIds.includes(id)
}

/**
 * Count accepted/reserved reassessments independently for the original gate.
 * @param run - validated run containing durable reservations.
 * @param target - original gate whose allowance is being checked.
 * @returns cumulative accepted responses, including plans not yet consumed.
 */
export function ownerReassessments(run: ConductorRun, target: GateId): number {
  return run.ownerLedger.filter(entry => entry.kind === 'answer' && entry.plan.gate === target).length
}

/**
 * Return the latest unanswered, non-expiring question.
 * @param run - validated durable run.
 * @returns current pending question, if any.
 */
export function pendingOwnerQuestion(run: ConductorRun): OwnerQuestion | undefined {
  const last = run.ownerLedger.at(-1)
  return last?.kind === 'question' ? last.question : undefined
}

/**
 * Return the accepted plan awaiting single-use consumption, including after restart.
 * @param run - validated durable run.
 * @returns current reserved plan, if any.
 */
export function pendingOwnerResumePlan(run: ConductorRun): OwnerResumePlan | undefined {
  const last = run.ownerLedger.at(-1)
  return last?.kind === 'answer' ? last.plan : undefined
}

/**
 * Derive a lifecycle override at the exact owner-ledger checkpoint only.
 * @param run - reconstructed run and its complete history.
 * @returns interaction-owned status, or undefined after a later gate.
 */
export function ownerLifecycleStatus(run: ConductorRun): 'awaiting_owner' | 'continuation_pending' | 'rework' | 'aborted' | undefined {
  const last = run.ownerLedger.at(-1)
  if (last === undefined || last.historyLength !== run.history.length) return undefined
  return last.kind === 'question' ? 'awaiting_owner' : last.kind === 'answer' ? 'continuation_pending' : last.kind === 'rejected' ? 'aborted' : 'rework'
}

/**
 * Bind a gate-history continuation to its exact consumed question and plan.
 * @param run - validated durable run.
 * @param historyLength - gate boundary immediately preceding the next assessment.
 * @returns consumed question/plan pair for this boundary, if any.
 */
export function ownerContinuationAt(
  run: ConductorRun, historyLength: number,
): { question: OwnerQuestion; plan: OwnerResumePlan } | undefined {
  const consumed = run.ownerLedger.find(entry => entry.kind === 'consumed' && entry.historyLength === historyLength)
  if (consumed?.kind !== 'consumed') return undefined
  const answer = run.ownerLedger.find(entry => entry.kind === 'answer' && entry.questionId === consumed.questionId)
  const question = run.ownerLedger.find(entry => entry.kind === 'question' && entry.question.id === consumed.questionId)
  if (answer?.kind !== 'answer' || question?.kind !== 'question') return undefined
  return { question: question.question, plan: answer.plan }
}

function challengeReworkGate(run: ConductorRun, question: OwnerQuestion) {
  const source = run.history[question.gateIndex]
  return run.admission.purpose === 'analysis' && source?.kind === 'evaluated'
    && source.gate === 'C' && source.analysis?.mode === 'critic'
    && source.analysis.challengeHash !== undefined && source.analysis.conclusion === 'does_not_hold'
    ? source : undefined
}

function resumeStage(run: ConductorRun, question: OwnerQuestion): ConductorStage {
  if (question.proposal !== undefined) return 'strategist'
  const source = challengeReworkGate(run, question)
  if (source === undefined) return question.stage
  if (source.nextStage === undefined || !['detective', 'strategist', 'devils-advocate'].includes(source.nextStage)) {
    fail('critical challenge has no read-only owner continuation')
  }
  return source.nextStage
}

/**
 * Reconstruct the read-only dispatch mode and prerequisite returns after an owner answer.
 * @param run - exact recorded escalation and accepted challenge.
 * @param question - question bound to the escalated gate.
 * @param plan - reserved host-derived continuation stage.
 * @param repairReturns - pending prerequisite returns at the owner checkpoint.
 * @returns resumed analysis mode and return stack; neither grants execution authority.
 */
export function ownerContinuationRoute(
  run: ConductorRun, question: OwnerQuestion, plan: OwnerResumePlan, repairReturns: RepairReturn[],
): { analysisMode: ConductorRun['analysisMode']; repairReturns: RepairReturn[] } {
  if (run.admission.purpose !== 'analysis') return { analysisMode: null, repairReturns }
  const source = run.history[question.gateIndex]
  const challengeGate = challengeReworkGate(run, question)
  if (challengeGate !== undefined) {
    const challenge = run.analysisChallenges.find(item => item.hash === challengeGate.analysis?.challengeHash)
    if (challenge?.challenge.conclusion !== 'does_not_hold') fail('owner continuation requires its exact failed challenge')
    const transition = transitionRoute({ admission: run.admission, analysisMode: 'critic',
      currentStage: question.stage, repairReturns }, 'rework', challenge.challenge.defect, plan.stage)
    return { analysisMode: plan.stage === reportProducer(run.admission) ? 'producer' : null,
      repairReturns: transition.repairReturns }
  }
  if (plan.stage === 'devils-advocate' && source?.kind === 'evaluated') {
    const mode = source.analysis?.mode
    if (mode === undefined) fail('analysis owner continuation requires typed Gate C dispatch')
    return { analysisMode: mode, repairReturns }
  }
  return { analysisMode: plan.stage === reportProducer(run.admission) ? 'producer' : null, repairReturns }
}

function validateAnswers(
  question: OwnerQuestion, action: 'approve' | 'answer_continue', answers: ScriptedOwnerResponse['answers'], proposalHash?: string,
): void {
  if (answers.length !== question.items.length || new Set(answers.map(answer => answer.itemId)).size !== answers.length) fail('answer must cover every required item exactly once')
  for (const item of question.items) {
    const answer = answers.find(candidate => candidate.itemId === item.id)
    if (answer === undefined || (item.options.length > 0 && !item.options.includes(answer.optionId as string))
      || (item.options.length === 0 && answer.optionId !== undefined)) fail(`invalid answer for required item ${item.id}`)
  }
  if (action === 'approve' && question.proposal === undefined) fail('approve requires a concrete mandate proposal')
  if (question.proposal === undefined ? proposalHash !== undefined : proposalHash !== ownerMandateHash(question.proposal)) fail('response must explicitly confirm the exact mandate proposal')
}

function validateProposal(run: ConductorRun, question: OwnerQuestion): void {
  if (question.proposal === undefined) {
    if (question.cause === 'authority-amendment') fail('authority amendment requires a concrete proposal')
    if (question.items.length === 0) fail('clarification requires at least one required item')
    return
  }
  if (run.admission.purpose === 'analysis') fail('analysis cannot acquire implementation authority')
  if (question.cause !== 'authority-amendment') fail('a mandate proposal requires authority-amendment classification')
  const capabilities = run.ownerCapabilities
  const proposal = question.proposal
  if (capabilities === null) fail('mandate proposal requires host-captured capabilities')
  if (![...run.excludedPaths, ...capabilities.excludedPaths].every(path => proposal.excludedPaths.includes(path))) fail('mandate proposal cannot remove mandatory exclusions')
  const canonicalPath = (path: string): boolean => path === '.' || (!/^(?:[a-z]:|[/\\])/i.test(path)
    && !path.includes('\\') && !path.includes('\0') && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'))
  if ([...question.proposal.allowedPaths, ...question.proposal.excludedPaths].some(path => !canonicalPath(path))
    || question.proposal.allowedPaths.some(path => path.split('/').some(segment => segment.toLowerCase() === '.git'))) fail('mandate proposal paths must be canonical relative workspace paths outside Git metadata')
  if (question.proposal.allowedPaths.some(path => !capabilities.allowedPaths.some(root => root === '.' || path === root || path.startsWith(`${root}/`)))) fail('mandate proposal exceeds host workspace capabilities')
  if (question.proposal.qualityCommandIds.some(id => !capabilities.qualityCommandIds.includes(id))) fail('mandate proposal names an unavailable host command')
}

/**
 * Validate untrusted durable JSON and its complete causal relation to gate history.
 * @param run - reconstructed run; this function trusts no owner ledger cast.
 */
export function assertOwnerLedger(run: ConductorRun): void {
  const parsed = ledgerSchema.safeParse(run.ownerLedger)
  if (!parsed.success) fail(`invalid interaction schema: ${parsed.error.message}`)
  if (!Number.isSafeInteger(run.ownerRevision) || run.ownerRevision !== run.ownerLedger.length) fail('ownerRevision must equal the complete ledger length')
  if (!Number.isSafeInteger(run.budget.maxOwnerReassessmentsPerGate) || run.budget.maxOwnerReassessmentsPerGate < 1) fail('maxOwnerReassessmentsPerGate must be a positive safe integer')
  if (run.ownerSessionId !== null && !identity.safeParse(run.ownerSessionId).success) fail('ownerSessionId must be a normalized root session identity or null')
  if (run.ownerCapabilities !== null && !mandateSchema.safeParse(run.ownerCapabilities).success) fail('invalid host capability snapshot')
  let previousLength = 0
  let pending: OwnerQuestion | undefined
  let answer: Extract<OwnerInteraction, { kind: 'answer' }> | undefined
  let mandate = originalMandate(run)
  let mandateRevision = 0
  const questions = new Set<string>()
  const children = new Set<string>()
  let previousQuestionGate = -1
  const counts = new Map<GateId, number>()
  for (const [index, entry] of run.ownerLedger.entries()) {
    if (entry.revision !== index + 1 || entry.previousRevision !== index || entry.historyLength < previousLength
      || entry.historyLength > run.history.length) fail('non-monotonic owner revision or gate-history position')
    previousLength = entry.historyLength
    if (entry.kind === 'question') {
      const question = entry.question
      const source = run.history[question.gateIndex]
      if (pending !== undefined || questions.has(question.id) || children.has(question.childId)
        || question.gateIndex <= previousQuestionGate
        || question.runId !== run.runId || question.rootSessionId !== run.ownerSessionId
        || question.historyLength !== entry.historyLength || question.gateIndex !== entry.historyLength - 1
        || source?.kind !== 'evaluated' || source.decision !== 'escalate' || source.stage !== question.stage
        || source.gate !== gateByStage[question.stage] || question.childId === question.rootSessionId) fail('question is not bound to its exact escalated gate and root/child identity')
      if (challengeReworkGate(run, question) !== undefined) resumeStage(run, question)
      if (source.origin === 'critic-budget') {
        fail('child owner question requires a real child source')
      }
      if (source.analysis?.childId !== undefined && (question.childId !== source.analysis.childId
        || source.analysis.mode === 'critic' && question.attempt !== source.analysis.criticAttempt)) {
        fail('child owner question must match the exact analysis dispatch')
      }
      if (question.mandateRevision !== mandateRevision || question.mandateHash !== ownerMandateHash(mandate)) fail('question mandate is stale')
      if (question.reportHash !== contentHash(JSON.stringify(question.report))) fail('question report hash does not match its captured child output')
      if (question.baselineHash !== null && !run.baselineHistory.some(baseline => executionBaselineHash(baseline) === question.baselineHash)) fail('question references an unknown historical baseline')
      if (new Set(question.items.map(item => item.id)).size !== question.items.length) fail('required question item identities must be distinct')
      if ((counts.get(source.gate) ?? 0) >= run.budget.maxOwnerReassessmentsPerGate) fail(`gate ${source.gate} owner reassessment limit exhausted`)
      validateProposal(run, question)
      questions.add(question.id)
      children.add(question.childId)
      previousQuestionGate = question.gateIndex
      pending = question
      answer = undefined
      continue
    }
    if (pending === undefined || entry.questionId !== pending.id || entry.historyLength !== pending.historyLength) fail('response or consumption has no exact pending question')
    if (entry.kind === 'answer') {
      if (answer !== undefined) fail('question already has an accepted response')
      validateAnswers(pending, entry.action, entry.answers, entry.proposalHash)
      const sourceGate = (run.history[pending.gateIndex] as GateRecord).gate
      const nextMandateRevision = mandateRevision + (pending.proposal === undefined ? 0 : 1)
      if (entry.plan.id !== `${pending.id}:resume` || entry.plan.questionId !== pending.id || entry.plan.gateIndex !== pending.gateIndex
        || entry.plan.gate !== sourceGate || entry.plan.stage !== resumeStage(run, pending)
        || entry.plan.mandateRevision !== nextMandateRevision) fail('resume plan differs from its host-derived gate and mandate')
      const consumed = (counts.get(sourceGate) ?? 0) + 1
      counts.set(sourceGate, consumed)
      if (pending.proposal !== undefined) mandate = structuredClone(pending.proposal)
      mandateRevision = nextMandateRevision
      answer = entry
    } else if (entry.kind === 'consumed') {
      if (answer === undefined || entry.planId !== answer.plan.id) fail('continuation is not reserved or has already been consumed')
      pending = undefined
      answer = undefined
    } else {
      if (answer !== undefined || index !== run.ownerLedger.length - 1) fail('rejection must terminate an unanswered question')
      pending = undefined
    }
  }
  const last = run.ownerLedger.at(-1)
  if (last?.historyLength === run.history.length) {
    const expected = last.kind === 'question' ? 'awaiting_owner' : last.kind === 'answer' ? 'continuation_pending' : last.kind === 'rejected' ? 'aborted' : 'rework'
    if (run.status !== expected) fail(`latest owner interaction requires status ${expected}`)
    const activeHash = run.baseline === null ? null : executionBaselineHash(run.baseline)
    const boundQuestion = last.kind === 'question' ? last.question
      : (run.ownerLedger.find(entry => entry.kind === 'question' && entry.question.id === last.questionId) as Extract<OwnerInteraction, { kind: 'question' }>).question
    const amended = last.kind === 'answer' && last.proposalHash !== undefined
      || last.kind === 'consumed' && boundQuestion.proposal !== undefined
    if (!amended && last.kind !== 'rejected' && activeHash !== boundQuestion.baselineHash) fail('pending question baseline is stale')
    if (last.kind === 'answer' && last.proposalHash !== undefined && (run.baseline !== null || run.executionAuthorization !== null)) fail('accepted mandate amendment must invalidate active baseline and authorization')
    if (last.kind === 'consumed') {
      const continuation = ownerContinuationAt(run, last.historyLength) as { question: OwnerQuestion; plan: OwnerResumePlan }
      if (run.currentStage !== continuation.plan.stage) fail('consumed continuation requires its exact target stage')
      if (continuation.question.proposal !== undefined && run.repairReturns.length !== 0) fail('mandate amendment must clear the superseded repair stack')
      if (continuation.question.proposal !== undefined && (run.baseline !== null || run.executionAuthorization !== null)) fail('mandate amendment must invalidate active baseline and authorization')
    }
  } else if (pending !== undefined) fail('gate history changed while an owner interaction was pending')
  if (last === undefined && (run.status === 'awaiting_owner' || run.status === 'continuation_pending')) fail('owner-waiting status requires a durable interaction')
}

/**
 * Park one explicitly classified escalation without exposing any production answer path.
 * @param run - run whose last evaluated gate escalated.
 * @param id - host-minted stable question identity.
 * @param escalation - typed classification; terminal failures cannot become questions.
 * @param source - host-captured child report with exact hash.
 * @param items - complete required clarification items.
 * @param proposal - optional exact host-capability-validated mandate preview.
 * @returns an immutable parked run; no authority or gate allowance is granted.
 */
export function parkOwnerQuestion(
  run: ConductorRun, id: string, escalation: OwnerEscalation, source: OwnerQuestionSource,
  items: OwnerQuestionItem[], proposal?: OwnerMandate,
): ConductorRun {
  assertOwnerLedger(run)
  if (escalation.kind === 'terminal') fail(`terminal ${escalation.cause}: ${escalation.reason}`)
  if (run.status !== 'escalated' || run.ownerSessionId === null) fail('parking requires an escalated run with a host-owned root session')
  const sourceGate = run.history.at(-1) as GateRecord
  const used = ownerReassessments(run, sourceGate.gate)
  if (used >= run.budget.maxOwnerReassessmentsPerGate) fail(
    `run ${run.runId}, gate ${sourceGate.gate}: ${used}/${run.budget.maxOwnerReassessmentsPerGate} owner reassessments consumed; ${escalation.reason}`,
  )
  const question: OwnerQuestion = { id, runId: run.runId, rootSessionId: run.ownerSessionId,
    gateIndex: run.history.length - 1, historyLength: run.history.length, stage: sourceGate.stage,
    ...source, mandateRevision: run.ownerLedger.filter(entry => entry.kind === 'answer' && entry.proposalHash !== undefined).length,
    mandateHash: ownerMandateHash(effectiveOwnerMandate(run)),
    baselineHash: run.baseline === null ? null : executionBaselineHash(run.baseline),
    cause: escalation.cause, reason: escalation.reason, items: structuredClone(items),
    ...proposal === undefined ? {} : { proposal: structuredClone(proposal) },
  }
  return append(run, { kind: 'question', question }, 'awaiting_owner')
}

type NewInteraction = OwnerInteraction extends infer Entry
  ? Entry extends OwnerInteraction ? Omit<Entry, 'revision' | 'previousRevision' | 'historyLength'> : never : never
function append(run: ConductorRun, entry: NewInteraction, status: ConductorRun['status']): ConductorRun {
  const updated: ConductorRun = { ...run, status, ownerRevision: run.ownerRevision + 1,
    ownerLedger: [...run.ownerLedger, { ...structuredClone(entry), revision: run.ownerRevision + 1,
      previousRevision: run.ownerRevision, historyLength: run.history.length }] }
  assertOwnerLedger(updated)
  return updated
}

/**
 * Atomically retain a host response, its mandate amendment and budget-reserved plan.
 * @param run - parked run owned by the live controller.
 * @param response - explicit host response bound to current owner revision.
 * @returns rejected terminal run, or continuation-pending run. Identical replies are idempotent.
 */
export function applyScriptedOwnerAnswer(run: ConductorRun, response: ScriptedOwnerResponse): ConductorRun {
  assertOwnerLedger(run)
  if (!scriptedSourceSchema.safeParse(response).success) fail('owner response requires a host UI or scripted test provider source')
  const questionEntry = run.ownerLedger.find(entry => entry.kind === 'question' && entry.question.id === response.questionId)
  if (questionEntry?.kind !== 'question' || response.rootSessionId !== run.ownerSessionId || response.expectedRevision !== questionEntry.revision) fail('foreign or stale owner response')
  const prior = run.ownerLedger.find(entry => (entry.kind === 'answer' || entry.kind === 'rejected') && entry.questionId === response.questionId)
  if (prior !== undefined) {
    if ((prior.kind === 'rejected' && response.action === 'reject' && response.answers.length === 0 && response.proposalHash === undefined)
      || (prior.kind === 'answer' && prior.action === response.action && equal(prior.answers, response.answers) && prior.proposalHash === response.proposalHash)) return run
    fail('conflicting response to an already answered question')
  }
  if (response.action === 'reject') {
    if (response.answers.length !== 0 || response.proposalHash !== undefined) fail('rejection cannot carry answers or grant a mandate')
    return append(run, { kind: 'rejected', questionId: response.questionId }, 'aborted')
  }
  const question = questionEntry.question
  const plan: OwnerResumePlan = { id: `${question.id}:resume`, questionId: question.id, gateIndex: question.gateIndex,
    gate: (run.history[question.gateIndex] as GateRecord).gate, stage: resumeStage(run, question),
    mandateRevision: question.mandateRevision + (question.proposal === undefined ? 0 : 1) }
  return append({ ...run, ...question.proposal === undefined ? {} : { baseline: null, executionAuthorization: null } },
    { kind: 'answer', questionId: question.id, action: response.action, answers: structuredClone(response.answers),
      ...response.proposalHash === undefined ? {} : { proposalHash: response.proposalHash }, plan }, 'continuation_pending')
}

/**
 * Consume a reserved reassessment exactly once; never dispatch or grant Gate C approval.
 * @param run - durable continuation-pending run, including one reconstructed after restart.
 * @param questionId - exact host-bound question whose plan is being consumed.
 * @returns run at the original role, or Strategist for an amended mandate.
 */
export function consumeOwnerContinuation(run: ConductorRun, questionId: string): ConductorRun {
  assertOwnerLedger(run)
  const last = run.ownerLedger.at(-1)
  if (last?.kind !== 'answer' || last.questionId !== questionId || run.status !== 'continuation_pending') fail('no unconsumed owner continuation for this question')
  const question = run.ownerLedger.find(entry => entry.kind === 'question' && entry.question.id === questionId) as Extract<OwnerInteraction, { kind: 'question' }>
  const route = ownerContinuationRoute(run, question.question, last.plan, run.repairReturns)
  return append({ ...run, currentStage: last.plan.stage, analysisMode: route.analysisMode,
    repairReturns: question.question.proposal === undefined ? route.repairReturns : [],
    ...question.question.proposal === undefined ? {} : { baseline: null, executionAuthorization: null } },
  { kind: 'consumed', questionId, planId: last.plan.id }, 'rework')
}
