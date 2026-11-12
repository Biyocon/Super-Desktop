/**
 * Required-on-read owner-interaction facts projected from the authoritative ledger.
 * @module @deepseek-ai/dsh-conductor/owner-events
 */
import { z } from 'zod'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { isDeepStrictEqual } from 'node:util'
import type { ConductorRun, ConductorRunId } from './types.ts'
import type { OwnerInteraction, OwnerTransportBinding } from './owner-types.ts'
import { applyScriptedOwnerAnswer, consumeOwnerContinuation, parkOwnerQuestion, parseOwnerInteraction } from './owner-ledger.ts'

/** A typed interaction fact bound to one run and ledger revision. */
export interface OwnerInteractionEvent<K extends OwnerInteraction['kind']> {
  runId: ConductorRunId
  interaction: Extract<OwnerInteraction, { kind: K }>
  transport?: OwnerTransportBinding
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Required durable question identity and exact specialist provenance. */
    'conductor/owner-question-created': OwnerInteractionEvent<'question'>
    /** Required durable answer and its single-use reassessment plan. */
    'conductor/owner-response-recorded': OwnerInteractionEvent<'answer'>
    /** Required fact that one exact reassessment plan has been consumed. */
    'conductor/owner-continuation-consumed': OwnerInteractionEvent<'consumed'>
    /** Required owner rejection; never an authorization to continue. */
    'conductor/owner-terminal-rejection': OwnerInteractionEvent<'rejected'>
    /** The paired answer/rejection checkpoint was flushed successfully before this fact. */
    'conductor/owner-response-acknowledged': OwnerAcknowledgement
  }
}


/** Receipt certifying that the exact answer checkpoint passed the host flush barrier. */
export interface OwnerAcknowledgement {
  runId: ConductorRunId
  questionId: string
  revision: number
  status: 'accepted' | 'rejected'
}

const acknowledgementSchema = z.object({
  runId: z.string().regex(/^CON-\d{4}-\d{4}$/), questionId: z.string().min(1).max(256).refine(value => value === value.trim()),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), status: z.enum(['accepted', 'rejected']),
}).strict()

/**
 * Decode a required durable-receipt fact; ledger reconstruction checks its causal reference.
 * @param value - untrusted session-event data.
 * @returns the exact answer/rejection identity and committed status.
 */
export function decodeOwnerAcknowledgement(value: unknown): OwnerAcknowledgement {
  const data = acknowledgementSchema.parse(value)
  return { ...data, runId: data.runId as ConductorRunId }
}

function acknowledgedEntry(run: ConductorRun, value: OwnerAcknowledgement): boolean {
  return run.ownerLedger.some(entry => (entry.kind === 'answer' || entry.kind === 'rejected')
    && entry.questionId === value.questionId && entry.revision === value.revision
    && value.status === (entry.kind === 'answer' ? 'accepted' : 'rejected'))
}

/**
 * Publish a receipt only after the caller has flushed this exact answer checkpoint.
 * The enclosing host turn flushes the receipt before acknowledging its transport.
 * @param session - live owning session with its host turn open.
 * @param run - already flushed answer or rejection checkpoint.
 * @param questionId - exact question settled by that checkpoint.
 */
export function publishOwnerAcknowledgement(session: Session, run: ConductorRun, questionId: string): void {
  const entry = run.ownerLedger.find(item => (item.kind === 'answer' || item.kind === 'rejected') && item.questionId === questionId)
  if (entry === undefined || run.ownerSessionId !== session.id) {
    throw new Error('Conductor cannot acknowledge an answer outside its owning ledger')
  }
  const data: OwnerAcknowledgement = { runId: run.runId, questionId, revision: entry.revision,
    status: entry.kind === 'answer' ? 'accepted' : 'rejected' }
  const previous = session.events.find(event => event.type === 'conductor/owner-response-acknowledged'
    && event.data.runId === run.runId && event.data.questionId === questionId)
  if (previous !== undefined) {
    if (!isDeepStrictEqual(decodeOwnerAcknowledgement(previous.data), data)) throw new Error('Conductor owner receipt conflicts with its ledger')
    return
  }
  session.append('conductor/owner-response-acknowledged', data)
}

const typeByKind = {
  question: 'conductor/owner-question-created', answer: 'conductor/owner-response-recorded',
  consumed: 'conductor/owner-continuation-consumed', rejected: 'conductor/owner-terminal-rejection',
} as const

/**
 * Append missing required interaction facts, including a checkpoint-only crash tail.
 * @param session - authoritative owning session, with an open host or tool turn.
 * @param run - validated checkpoint whose complete ledger owns these facts.
 * @param transport - host-issued binding retained only on its exact response fact.
 */
export function publishOwnerInteractions(session: Session, run: ConductorRun, transport?: OwnerTransportBinding): void {
  for (const interaction of run.ownerLedger) {
    const type = typeByKind[interaction.kind]
    const previous = session.events.filter(event => event.type === 'conductor/owner-question-created'
      || event.type === 'conductor/owner-response-recorded' || event.type === 'conductor/owner-continuation-consumed'
      || event.type === 'conductor/owner-terminal-rejection').find(event => event.type === type
      && event.data.runId === run.runId && event.data.interaction.revision === interaction.revision)
    if (previous !== undefined) {
      if (!isDeepStrictEqual(previous.data.interaction, interaction)) {
        throw new Error('Conductor owner event conflicts with its authoritative ledger')
      }
      continue
    }
    // Keep the discriminated event and interaction paired for wire generation.
    const responseTransport = transport !== undefined && (interaction.kind === 'answer' || interaction.kind === 'rejected')
      && interaction.questionId === transport.questionId ? { transport } : {}
    switch (interaction.kind) {
      case 'question': session.append(typeByKind.question, { runId: run.runId, interaction }); break
      case 'answer': session.append(typeByKind.answer, { runId: run.runId, interaction, ...responseTransport }); break
      case 'consumed': session.append(typeByKind.consumed, { runId: run.runId, interaction }); break
      case 'rejected': session.append(typeByKind.rejected, { runId: run.runId, interaction, ...responseTransport }); break
    }
  }
}

/**
 * Decode a required owner event and reject mismatched type or run identity.
 * @param type - event type obtained from the durable envelope.
 * @param value - untrusted storage or transport data.
 * @returns decoded interaction data; no reservation or dispatch is created.
 */
export function decodeOwnerInteractionEvent(type: string, value: unknown): OwnerInteractionEvent<OwnerInteraction['kind']> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !('runId' in value) || typeof value.runId !== 'string' || !/^CON-\d{4}-\d{4}$/.test(value.runId)
    || !('interaction' in value) || Object.keys(value).some(key => !['runId', 'interaction', 'transport'].includes(key))) {
    throw new Error('Invalid Conductor owner-interaction event')
  }
  const interaction = parseOwnerInteraction(value.interaction)
  if (type !== typeByKind[interaction.kind] || interaction.kind === 'question' && interaction.question.runId !== value.runId) {
    throw new Error('Conductor owner-interaction event type or run mismatch')
  }
  let transport: OwnerTransportBinding | undefined
  if ('transport' in value) {
    const raw = value.transport
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
      || !('runId' in raw) || raw.runId !== value.runId
      || !('questionId' in raw) || (interaction.kind !== 'answer' && interaction.kind !== 'rejected') || raw.questionId !== interaction.questionId
      || !('rootSessionId' in raw) || typeof raw.rootSessionId !== 'string' || raw.rootSessionId.length === 0
      || !('revision' in raw) || raw.revision !== interaction.previousRevision
      || !('transportId' in raw) || typeof raw.transportId !== 'string' || raw.transportId.length === 0
      || Object.keys(raw).length !== 5) throw new Error('Invalid Conductor owner response transport')
    transport = raw as OwnerTransportBinding
  }
  return { runId: value.runId as ConductorRunId, interaction, ...transport === undefined ? {} : { transport } }
}

/**
 * Reconcile fully written owner facts after a checkpoint-only crash boundary.
 * @param initial - last complete validated checkpoint.
 * @param events - durable events following that checkpoint.
 * @returns reconciled state, without dispatching or writing any new event.
 */
export function replayOwnerInteractions(initial: ConductorRun, events: readonly SessionEvent[]): ConductorRun {
  let run = initial
  for (const event of events) {
    if (event.type === 'conductor/owner-response-acknowledged') {
      const acknowledgement = decodeOwnerAcknowledgement(event.data)
      if (acknowledgement.runId !== run.runId) continue
      if (!acknowledgedEntry(run, acknowledgement)) throw new Error('Conductor owner receipt contradicts its answer checkpoint')
      continue
    }
    if (event.type !== 'conductor/owner-question-created' && event.type !== 'conductor/owner-response-recorded'
      && event.type !== 'conductor/owner-continuation-consumed' && event.type !== 'conductor/owner-terminal-rejection') continue
    const data = decodeOwnerInteractionEvent(event.type, event.data)
    if (data.runId !== run.runId) continue
    const entry = data.interaction
    if (entry.previousRevision !== run.ownerRevision) throw new Error('Conductor owner recovery revision mismatch')
    switch (entry.kind) {
      case 'question': {
        const q = entry.question
        run = parkOwnerQuestion(run, q.id, { kind: 'recoverable', cause: q.cause, reason: q.reason },
          { sourceKind: q.sourceKind, childId: q.childId, attempt: q.attempt,
            report: q.report, reportHash: q.reportHash }, q.items, q.proposal)
        break
      }
      case 'answer': case 'rejected':
        run = applyScriptedOwnerAnswer(run, { source: 'scripted-test-provider', rootSessionId: run.ownerSessionId as SessionId,
          questionId: entry.questionId, expectedRevision: entry.previousRevision,
          action: entry.kind === 'rejected' ? 'reject' : entry.action,
          answers: entry.kind === 'rejected' ? [] : entry.answers,
          ...entry.kind === 'answer' && entry.proposalHash !== undefined ? { proposalHash: entry.proposalHash } : {} })
        break
      case 'consumed': run = consumeOwnerContinuation(run, entry.questionId); break
    }
    if (!isDeepStrictEqual(run.ownerLedger.at(-1), entry)) throw new Error('Conductor owner recovery contradicts its ledger')
    if (data.transport !== undefined && data.transport.rootSessionId !== run.ownerSessionId) {
      throw new Error('Conductor owner recovery belongs to another root session')
    }
  }
  return run
}
