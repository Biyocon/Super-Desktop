/** Causal gate-history validation shared by both admitted workflow purposes. */
import type { ConductorRun, ConductorStage, GateId, RepairReturn } from './types.ts'
import { admittedRoute, GATED_STAGES, reportProducer, transitionRoute } from './intake.ts'
import { ownerContinuationAt, ownerContinuationRoute } from './owner-ledger.ts'

/**
 * Reject forged skips, invalid causal returns, reset budgets and impossible stages.
 * @param run - structurally parsed durable run.
 */
export function validateIntakeHistory(run: ConductorRun): void {
  const order = GATED_STAGES as readonly ConductorStage[]
  const route = admittedRoute(run.admission)
  let currentStage: ConductorStage = 'detective'
  let destination: ConductorStage = run.admission.entry
  let repairReturns: RepairReturn[] = []
  let analysisMode: ConductorRun['analysisMode'] = run.admission.purpose === 'analysis'
    && run.admission.entry === reportProducer(run.admission) ? 'producer' : null
  let evaluated = false
  let terminal = false
  const counts = new Map<GateId, number>()
  for (let historyIndex = 0; historyIndex <= run.history.length; historyIndex++) {
    const continuation = ownerContinuationAt(run, historyIndex)
    if (continuation !== undefined) {
      if (!terminal || run.history[historyIndex - 1]?.decision !== 'escalate') {
        throw new Error('Conductor owner continuation must follow its documented escalation')
      }
      currentStage = continuation.plan.stage
      destination = currentStage
      const resumed = ownerContinuationRoute(run, continuation.question, continuation.plan, repairReturns)
      analysisMode = resumed.analysisMode
      repairReturns = continuation.question.proposal === undefined ? resumed.repairReturns : []
      terminal = false
    }
    const gate = run.history[historyIndex]
    if (gate === undefined) break
    // Discriminants and optional origin still come from durable JSON here.
    const metadata = gate as { kind: unknown; decision: unknown; origin?: unknown }
    if (terminal) throw new Error('Conductor history cannot continue after a terminal gate')
    const keys = gate.kind === 'skipped'
      ? ['kind', 'gate', 'stage', 'decision', 'reason', 'purpose', 'deliverable', 'route', 'basis', 'evidenceReviewed', 'stateUpdate', 'nextStage']
      : ['kind', 'gate', 'stage', 'decision', 'origin', 'analysis', 'defectClass', 'executionBaselineHash', 'basis', 'evidenceReviewed', 'stateUpdate', 'nextStage']
    if (Object.keys(gate).some(key => !keys.includes(key))) throw new Error('Conductor gate history contains unsupported fields')
    const index = order.indexOf(currentStage)
    if (index < 0 || gate.stage !== currentStage || gate.gate !== 'ABCDEFG'[index]) {
      throw new Error('Conductor history stage/gate does not follow its admitted causal route')
    }
    if (gate.kind === 'skipped') {
      const reason = evaluated ? 'profile-not-applicable' : 'supplied-work'
      if (currentStage === destination || metadata.decision !== 'skipped' || gate.nextStage !== order[index + 1]
        || gate.reason !== reason || gate.purpose !== run.admission.purpose
        || gate.deliverable !== (run.admission.purpose === 'analysis' ? run.admission.deliverable : undefined)
        || JSON.stringify(gate.route) !== JSON.stringify(route)
        || JSON.stringify(gate.basis) !== JSON.stringify([run.admission.rationale])
        || JSON.stringify(gate.evidenceReviewed) !== JSON.stringify(run.admission.materials.map(material => material.id))
        || (evaluated && route.includes(currentStage))
        || (!evaluated && index >= order.indexOf(run.admission.entry))) {
        throw new Error('Conductor skipped gate lacks a valid supplied-work or profile justification')
      }
      currentStage = gate.nextStage
      continue
    }
    if (metadata.kind !== 'evaluated' || currentStage !== destination) throw new Error('Conductor evaluated gate bypasses required skip records')
    if (metadata.origin === 'intake-validation') {
      if (evaluated || gate.decision !== 'rework' || gate.analysis !== undefined) {
        throw new Error('Conductor admission repair must precede specialist evaluation')
      }
    } else if (metadata.origin === 'critic-budget') {
      if (run.admission.purpose !== 'analysis' || gate.gate !== 'C' || analysisMode !== 'critic'
        || gate.decision !== 'escalate' || gate.analysis !== undefined) {
        throw new Error('Conductor critic budget must stop its exact Gate C dispatch')
      }
    } else if (metadata.origin !== undefined) throw new Error('Conductor gate has an unknown source')
    if (run.admission.purpose === 'analysis' && gate.gate === 'C' && metadata.origin === undefined
      && gate.analysis?.mode !== analysisMode) {
      throw new Error('Conductor Gate C mode does not match its causal route')
    }
    if (run.admission.purpose === 'analysis' && metadata.origin === undefined
      && gate.decision !== 'abort' && currentStage === reportProducer(run.admission) && analysisMode === 'producer'
      && gate.analysis?.mode !== 'producer') {
      throw new Error('Conductor report producer gate must record its typed dispatch')
    }
    evaluated = true
    terminal = gate.decision === 'abort' || gate.decision === 'escalate' || gate.gate === 'G' && gate.decision === 'pass'
    if (gate.decision === 'rework') {
      const count = (counts.get(gate.gate) ?? 0) + 1
      if (count > run.budget.maxReworkPerGate) throw new Error('Conductor gate exceeds its per-gate rework budget')
      counts.set(gate.gate, count)
    }
    const producerPassedAtC = run.admission.purpose === 'analysis' && gate.gate === 'C'
      && gate.analysis?.mode === 'producer' && gate.decision === 'pass'
    const transition: { nextStage: ConductorStage | undefined; repairReturns: RepairReturn[] } = producerPassedAtC
      ? { nextStage: 'devils-advocate' as const, repairReturns: [...repairReturns] }
      : transitionRoute({ admission: run.admission, analysisMode, currentStage, repairReturns }, gate.decision,
        gate.defectClass, gate.decision === 'pass' ? undefined : gate.nextStage)
    repairReturns = transition.repairReturns
    destination = transition.nextStage ?? currentStage
    if (run.admission.purpose === 'analysis') {
      analysisMode = producerPassedAtC ? 'critic'
        : gate.decision === 'escalate' ? analysisMode
          : gate.decision === 'rework' && gate.analysis?.mode === 'critic' && gate.analysis.challengeHash === undefined
            ? 'critic'
            : (gate.decision === 'pass' || gate.decision === 'rework') && destination === reportProducer(run.admission)
              ? 'producer'
              : gate.decision === 'pass' && destination === 'devils-advocate' ? 'critic' : null
    }
    const nextIndex = order.indexOf(destination)
    const immediate = gate.decision === 'pass' && nextIndex > index + 1 ? order[index + 1] : transition.nextStage
    if (gate.nextStage !== immediate) throw new Error('Conductor gate successor does not match its admitted transition')
    currentStage = immediate ?? currentStage
  }
  if (currentStage !== destination || run.currentStage !== currentStage || run.analysisMode !== analysisMode
    || JSON.stringify(repairReturns) !== JSON.stringify(run.repairReturns)) {
    throw new Error('Conductor current stage or pending repairs do not match its complete gate history')
  }
}
