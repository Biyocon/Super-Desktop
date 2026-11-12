/**
 * Host-owned owner-interaction records, separate from the gate history.
 * @module @deepseek-ai/dsh-conductor/owner-types
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConductorRunId, ConductorStage, GateId } from './types.ts'

/** Explicit causes eligible for owner input; errors never qualify by their text. */
export type RecoverableOwnerCause = 'clarification' | 'authority-amendment' | 'rework-exhausted'

/** Explicit non-recoverable failures; an owner answer cannot waive these boundaries. */
export type TerminalOwnerCause = 'identity' | 'routing' | 'unauthorized-execution' | 'baseline-tampering' | 'sandbox' | 'rejected-approval' | 'failure'

/** Runtime classification, captured independently of any model-authored explanation. */
export type OwnerEscalation =
  | { kind: 'recoverable'; cause: RecoverableOwnerCause; reason: string }
  | { kind: 'terminal'; cause: TerminalOwnerCause; reason: string }

/** Concrete paths and command identities previewed by a capability-validating host. */
export interface OwnerMandate {
  allowedPaths: string[]
  excludedPaths: string[]
  qualityCommandIds: string[]
}

/** Exact host-previewed amendment; command bodies remain owned by the host registry. */
export type OwnerMandateProposal = OwnerMandate

/** Required question item; options are stable machine identities, not translated labels. */
export interface OwnerQuestionItem {
  id: string
  prompt: string
  options: string[]
}

/** One question bound to the exact source child, gate, mandate and active baseline. */
export interface OwnerQuestion {
  id: string
  runId: ConductorRunId
  rootSessionId: SessionId
  gateIndex: number
  historyLength: number
  stage: ConductorStage
  sourceKind: 'child'
  childId: SessionId
  attempt: number
  reportHash: string
  report: unknown
  mandateRevision: number
  mandateHash: string
  baselineHash: string | null
  cause: RecoverableOwnerCause
  reason: string
  items: OwnerQuestionItem[]
  proposal?: OwnerMandate
}

/** A single required item's explicit answer. Free text never grants authority. */
export interface OwnerAnswer {
  itemId: string
  text: string
  optionId?: string
}

/** A budget-reserved same-run reassessment, consumed at most once. */
export interface OwnerResumePlan {
  id: string
  questionId: string
  gateIndex: number
  gate: GateId
  stage: ConductorStage
  mandateRevision: number
}

/** Causal ledger metadata. Gate records are never inserted into this sequence. */
export interface OwnerLedgerPosition {
  revision: number
  previousRevision: number
  historyLength: number
}

/** Append-only owner ledger; answer and its allowance reservation are atomic. */
export type OwnerInteraction = OwnerLedgerPosition & (
  | { kind: 'question'; question: OwnerQuestion }
  | { kind: 'answer'; questionId: string; action: 'approve' | 'answer_continue'; answers: OwnerAnswer[]; proposalHash?: string; plan: OwnerResumePlan }
  | { kind: 'consumed'; questionId: string; planId: string }
  | { kind: 'rejected'; questionId: string }
)

/** Host-captured provenance required before a recoverable escalation may be parked. */
export interface OwnerQuestionSource {
  sourceKind: 'child'
  childId: SessionId
  attempt: number
  reportHash: string
  report: unknown
}

/** Complete host response; only the controller turns a live UI answer into this private value. */
export interface ScriptedOwnerResponse {
  source: 'scripted-test-provider' | 'host-ui'
  rootSessionId: SessionId
  questionId: string
  expectedRevision: number
  action: 'approve' | 'reject' | 'answer_continue'
  answers: OwnerAnswer[]
  proposalHash?: string
}

/** Host-captured transport identity; an identifier alone never confers a reservation. */
export interface OwnerTransportBinding {
  runId: ConductorRunId
  questionId: string
  rootSessionId: SessionId
  revision: number
  transportId: string
}
