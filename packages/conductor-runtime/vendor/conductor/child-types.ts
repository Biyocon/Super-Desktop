/** Model-hidden presentation of one concrete Conductor workflow child. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConductorRunId, ConductorStage, GateId, GateDecision } from './types.ts'
import type { AnalysisChallenge } from './analysis-challenge.ts'

/** Fixed specialist identities, including the internal Ralph worker. */
export type ConductorChildRole = Extract<ConductorStage, 'detective' | 'strategist' | 'devils-advocate' | 'headsman' | 'auditor' | 'integrator' | 'arbiter' | 'ralph'>

/** Lifecycle and optional gate verdict for one child, never for an entire role. */
export interface ConductorChild {
  /** Concrete session owned by this dispatch. */
  childId: SessionId
  /** Conductor run that dispatched the child. */
  runId: ConductorRunId
  /** Runtime-selected role, independent of prompts and titles. */
  role: ConductorChildRole
  /** Typed analysis dispatch mode; absent for implementation and internal workers. */
  mode?: 'producer' | 'critic'
  /** One-based attempt for this role within this run. */
  attempt: number
  /** Run-wide critic attempt, present only for a critic dispatch. */
  criticAttempt?: number
  /** Gate history length when dispatch started; binds only a subsequent verdict. */
  historyOffset: number
  /** Workflow child lifecycle, independent of gate acceptance. */
  status: 'running' | 'completed' | 'failed'
  /** Present only after runtime evaluates this particular specialist's report. */
  gate?: {
    id: GateId
    decision: GateDecision
    reworks: number
    limit: number
    /** Validated challenge result for the exact critic child. */
    challengeConclusion?: 'holds' | 'does_not_hold'
    /** Complete validated challenge and its digest, retaining replayable candidate and critic identities. */
    challenge?: { hash: string; result: AnalysisChallenge }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Model-hidden child identity/lifecycle/verdict snapshot, keyed by childId. */
    'conductor/child': ConductorChild
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Concrete Conductor children of this parent session, including all attempts. */
    conductorChildren: Record<string, ConductorChild>
  }
}
