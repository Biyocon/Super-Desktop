/**
 * Conductor stage routing and rework mapping.
 *
 * Conductor is the only code that decides the next stage: a specialist result
 * carries only `recommended_transition.target = 'conductor'`, never the next
 * specialist. This module maps a specialist's envelope `status` to a gate
 * decision, and a defect class to the stage that owns the fix. It produces a
 * {@link RoutedGate} that the tool folds into a {@link GateVerdict} before the
 * state machine records it.
 *
 * @module @deepseek-ai/dsh-conductor/routing
 */

import type { ConductorStage, DefectClass, GateDecision, GateId, SpecialistStatus } from './types.ts'
import { nextStageAfterPass, stageOfGate } from './state.ts'

/**
 * Map a specialist's envelope `status` to Conductor's gate decision.
 * `ready` advances; `rework` routes back to the owning stage; `blocked` and
 * `failed` park the run for an owner decision (`escalate`).
 * @param status - the specialist's delivery readiness.
 * @returns the corresponding gate decision.
 */
export function decisionForStatus(status: SpecialistStatus): GateDecision {
  switch (status) {
    case 'ready':
      return 'pass'
    case 'rework':
      return 'rework'
    case 'blocked':
      return 'escalate'
    case 'failed':
      return 'escalate'
    /* v8 ignore start -- SpecialistStatus is a closed typed union; a future variant must fail loud here. */
    default:
      return assertNever(status)
    /* v8 ignore stop */
  }
}

/**
 * The stage that owns a defect class, and therefore the rework target for
 * that class.
 * @param defectClass - the class of defect the rework addresses.
 * @param stage - the reporting stage, which owns repairs to its own report.
 * @returns the owning stage.
 */
export function reworkTarget(defectClass: DefectClass, stage: ConductorStage): ConductorStage {
  switch (defectClass) {
    case 'analysis':
      throw new Error('Analysis defects require the admitted report producer')
    case 'report':
      return stage
    case 'scope':
      return 'detective'
    case 'plan':
      return 'strategist'
    case 'implementation':
      return 'headsman'
    case 'delivery':
      return 'integrator'
    /* v8 ignore start -- DefectClass is a closed typed union; a future variant must fail loud here. */
    default:
      return assertNever(defectClass)
    /* v8 ignore stop */
  }
}

/**
 * One routed gate: the decision, the defect class (on `rework`), and the stage
 * to route to (on `pass` and `rework`). `escalate` and `abort` carry no
 * successor stage — the run parks for an owner decision or stops.
 */
export interface RoutedGate {
  /** Conductor's decision. */
  decision: GateDecision
  /** The defect class, present only when the decision is `rework`. */
  defectClass?: DefectClass
  /** The stage to dispatch next; absent on `escalate` and `abort`. */
  nextStage?: ConductorStage
}

/**
 * Route a specialist result at one gate to a decision and the next stage.
 *
 * A `rework` at gates A through F routes to the stage owning the defect class.
 * At gate G only a malformed report returns to the Arbiter. Other defects
 * escalate for an owner decision rather than selecting another specialist.
 * @param gate - the gate being decided.
 * @param status - the specialist's envelope status.
 * @param defectClass - the defect class; required when `status` is `rework`.
 * @returns the routed decision and successor stage.
 */
export function routeGate(gate: GateId, status: SpecialistStatus, defectClass?: DefectClass): RoutedGate {
  let decision = decisionForStatus(status)
  let nextStage: ConductorStage | undefined

  switch (decision) {
    case 'pass':
      nextStage = nextStageAfterPass(stageOfGate(gate))
      break
    case 'rework': {
      if (defectClass === undefined) {
        throw new Error(`Conductor gate ${gate} rework requires a defect class`)
      }
      if (gate === 'G' && defectClass !== 'report') {
        decision = 'escalate'
        nextStage = undefined
      } else {
        nextStage = reworkTarget(defectClass, stageOfGate(gate))
      }
      break
    }
    case 'escalate':
      nextStage = undefined
      break
    /* v8 ignore start -- decisionForStatus cannot produce abort, and GateDecision is closed. */
    case 'abort':
      nextStage = undefined
      break
    default:
      assertNever(decision)
    /* v8 ignore stop */
  }

  const routed: RoutedGate = { decision }
  if (decision === 'rework' && defectClass !== undefined) {
    routed.defectClass = defectClass
  }
  if (nextStage !== undefined) {
    routed.nextStage = nextStage
  }
  return routed
}

/* v8 ignore start -- closed typed switches call this only if their declared unions gain an unhandled member. */
function assertNever(value: never): never {
  throw new Error(`Unreachable routing value: ${String(value)}`)
}
/* v8 ignore stop */
