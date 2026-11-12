/** Strict durable parsing for read-only report runs, separate from execution evidence. */
import type { AnalysisEnvelope, CapturedAnalysisChallenge, CapturedReport, ConductorMaterialId, ConductorRun, ConductorStage } from './types.ts'
import { analysisEnvelopeProblem, reportDecisionProblem, reportHash } from './analysis.ts'
import { validateAnalysisChallenge } from './analysis-challenge.ts'
import { reportProducer } from './intake.ts'
import { validateIntakeHistory } from './intake-history.ts'
import { ownerLifecycleStatus } from './owner-ledger.ts'

import { reportObject as object, reportTexts as texts } from './report-json.ts'


/**
 * Validate all analysis-specific fields and replay report/audit provenance.
 * @param record - run whose common owner, admission and budget fields are already parsed.
 * @returns the fully validated read-only run.
 */
export function parseAnalysisState(record: Record<string, unknown>): ConductorRun {
  if (record.baseline !== null || record.executionAuthorization !== null || record.decision !== undefined || record.closeout !== undefined
    || !Array.isArray(record.baselineHistory) || record.baselineHistory.length
    || !Array.isArray(record.qualityExecutions) || record.qualityExecutions.length
    || !Array.isArray(record.specialistReports) || record.specialistReports.length) {
    throw new Error('Conductor analysis record cannot carry execution baselines, authorization, quality work or closeout')
  }
  if (!['running', 'rework', 'escalated', 'aborted', 'reported', 'awaiting_owner', 'continuation_pending'].includes(String(record.status))
    || !['detective', 'strategist', 'devils-advocate', 'auditor', 'arbiter', 'report-complete'].includes(String(record.currentStage))
    || !Array.isArray(record.history) || !Array.isArray(record.repairReturns)
    || !Array.isArray(record.analysisReports) || !Array.isArray(record.reportCandidates)
    || !Array.isArray(record.analysisChallenges)
    || !['producer', 'critic', null].includes(record.analysisMode as string | null)) {
    throw new Error('Conductor analysis record has invalid lifecycle fields')
  }
  const run = record as unknown as ConductorRun
  if (run.admission.purpose !== 'analysis') throw new Error('Conductor analysis parser requires an admitted analysis run')
  const reconstructed: ConductorRun = { ...run, analysisReports: [], reportCandidates: [], analysisChallenges: [] }
  let reportIndex = 0
  let candidateIndex = 0
  let challengeIndex = 0
  let lastCriticAttempt = 0
  for (const [gateIndex, gate] of record.history.entries()) {
    if (!object(gate) || !texts(gate.basis) || !texts(gate.evidenceReviewed) || typeof gate.stateUpdate !== 'string') {
      throw new Error('Conductor analysis gate history is malformed')
    }
    if (gate.kind === 'skipped') {
      if (gate.executionBaselineHash !== undefined || gate.defectClass !== undefined) throw new Error('Skipped analysis gate cannot carry execution or repair fields')
      continue
    }
    if (gate.kind !== 'evaluated' || !['pass', 'rework', 'escalate', 'abort'].includes(String(gate.decision))
      || gate.executionBaselineHash !== undefined) throw new Error('Analysis gate must be an evaluated report decision without execution authority')
    if (gate.stage === 'arbiter' || gate.origin === 'intake-validation') continue
    if (gate.origin === 'critic-budget') {
      const candidate = reconstructed.reportCandidates.at(-1)
      if (gate.gate !== 'C' || gate.stage !== 'devils-advocate' || gate.decision !== 'escalate'
        || gate.analysis !== undefined || candidate === undefined || gate.basis.length !== 1
        || gate.stateUpdate !== `critic blocked: ${gate.basis[0]}`
        || JSON.stringify(gate.evidenceReviewed) !== JSON.stringify(candidate.candidate.material_ids)) {
        throw new Error('Conductor critic budget gate does not match the latest candidate')
      }
      continue
    }
    const analysis = gate.analysis
    if (analysis !== undefined && (!object(analysis) || Object.keys(analysis).some(key => ![
      'mode', 'candidateHash', 'childId', 'criticAttempt', 'challengeHash', 'inputTokens', 'outputTokens', 'conclusion',
    ].includes(key)))) throw new Error('Conductor analysis gate has malformed dispatch metadata')
    if (object(analysis) && (analysis.mode === 'producer'
      ? gate.stage !== reportProducer(run.admission) || typeof analysis.childId !== 'string' || !analysis.childId
        || analysis.criticAttempt !== undefined || analysis.challengeHash !== undefined
        || analysis.inputTokens !== undefined || analysis.outputTokens !== undefined || analysis.conclusion !== undefined
      : analysis.mode !== 'critic' || gate.stage !== 'devils-advocate')) {
      throw new Error('Conductor analysis dispatch mode does not match its producer or critic gate')
    }
    if (gate.stage === 'devils-advocate' && object(analysis) && analysis.mode === 'critic') {
      const candidate = reconstructed.reportCandidates.at(-1)
      if (candidate === undefined || analysis.candidateHash !== candidate.hash
        || typeof analysis.childId !== 'string' || analysis.childId.length === 0
        || !Number.isSafeInteger(analysis.criticAttempt) || analysis.criticAttempt !== lastCriticAttempt + 1
        || (analysis.inputTokens === undefined) !== (analysis.outputTokens === undefined)
        || analysis.inputTokens !== undefined && (!Number.isSafeInteger(analysis.inputTokens) || Number(analysis.inputTokens) < 0)
        || analysis.outputTokens !== undefined && (!Number.isSafeInteger(analysis.outputTokens) || Number(analysis.outputTokens) < 0)) {
        throw new Error('Conductor critic attempt has invalid candidate, child, sequence or measured usage')
      }
      lastCriticAttempt++
      if (analysis.challengeHash === undefined) {
        if (gate.decision === 'pass' || analysis.conclusion !== undefined
          || gate.decision === 'rework' && analysis.inputTokens === undefined
          || gate.decision === 'rework' && (gate.defectClass !== 'report' || gate.nextStage !== 'devils-advocate')) {
          throw new Error('Conductor critic gate pass requires a validated challenge')
        }
        continue
      }
      const captured: unknown = record.analysisChallenges[challengeIndex++]
      if (!object(captured) || Object.keys(captured).sort().join(',') !== 'candidateHash,challenge,criticAttempt,criticChildId,hash,inputTokens,outputTokens'
        || captured.hash !== analysis.challengeHash || captured.candidateHash !== candidate.hash
        || captured.criticChildId !== analysis.childId || captured.criticAttempt !== analysis.criticAttempt
        || captured.inputTokens !== analysis.inputTokens || captured.outputTokens !== analysis.outputTokens
        || typeof analysis.inputTokens !== 'number' || typeof analysis.outputTokens !== 'number') {
        throw new Error('Conductor retained challenge does not match its exact critic dispatch')
      }
      const validated = validateAnalysisChallenge(captured.challenge, {
        runId: run.runId, candidateHash: candidate.hash, candidateVersion: candidate.candidate.version,
        materialIds: candidate.candidate.material_ids as ConductorMaterialId[], criticChildId: analysis.childId,
        producerChildId: candidate.producerChildId, criticAttempt: lastCriticAttempt,
        dispatchMode: 'critic', entry: run.admission.entry, deliverable: run.admission.deliverable,
        producer: reportProducer(run.admission), maxSummaryCharacters: Number.MAX_SAFE_INTEGER,
        previous: reconstructed.analysisChallenges.map(previous => ({ challenge: previous.challenge, hash: previous.hash })),
      })
      const critical = validated.challenge?.findings.some(finding => finding.severity === 'critical') ?? false
      const exhausted = validated.challenge?.conclusion === 'does_not_hold' && !critical && gate.decision === 'escalate'
      const expectedBasis = exhausted
        ? [validated.challenge?.summary, `Gate C exhausted its ${run.budget.maxReworkPerGate} reworks per gate`]
        : [validated.challenge?.summary]
      const priorReworks = run.history.slice(0, gateIndex).filter(previous => previous.kind === 'evaluated'
        && previous.gate === 'C' && previous.decision === 'rework').length
      if (validated.problem !== undefined || validated.hash !== captured.hash
        || validated.challenge.conclusion !== analysis.conclusion
        || JSON.stringify(gate.basis) !== JSON.stringify(expectedBasis)
        || JSON.stringify(gate.evidenceReviewed) !== JSON.stringify(validated.challenge.material_ids)
        || gate.stateUpdate !== `critic ${validated.challenge.conclusion}`
        || (validated.challenge.conclusion === 'holds') !== (gate.decision === 'pass')
        || validated.challenge.conclusion === 'does_not_hold' && gate.decision === 'rework'
          && gate.defectClass !== validated.challenge.defect
        || validated.challenge.conclusion === 'does_not_hold' && !critical
          && gate.nextStage !== validated.reworkTarget
        || critical && gate.decision !== 'escalate'
        || exhausted && priorReworks < run.budget.maxReworkPerGate) {
        throw new Error(`Conductor analysis challenge does not match its Gate C assessment: ${validated.problem?.message ?? 'lineage or decision'}`)
      }
      reconstructed.analysisChallenges.push(captured as unknown as CapturedAnalysisChallenge)
      continue
    }
    const report: unknown = record.analysisReports[reportIndex]
    if (object(report) && report.stage === gate.stage && report.summary === gate.stateUpdate) {
      const problem = analysisEnvelopeProblem(report, gate.stage as ConductorStage, reconstructed)
      if (problem !== undefined) throw new Error(`Conductor analysis record: ${problem.message}`)
      const envelope = report as unknown as AnalysisEnvelope
      const expected = report.status === 'ready' ? 'pass' : report.status === 'rework' ? 'rework' : 'escalate'
      const exhausted = expected === 'rework' && gate.decision === 'escalate'
      const expectedBasis = exhausted
        ? [report.summary, `Gate ${String(gate.gate)} exhausted its ${run.budget.maxReworkPerGate} reworks per gate`]
        : [report.summary]
      const priorReworks = run.history.slice(0, gateIndex).filter(previous => previous.kind === 'evaluated'
        && previous.gate === gate.gate && previous.decision === 'rework').length
      if ((gate.decision !== expected && !(expected === 'rework' && gate.decision === 'escalate'))
        || JSON.stringify(gate.basis) !== JSON.stringify(expectedBasis)
        || JSON.stringify(gate.evidenceReviewed) !== JSON.stringify(report.material_ids)
        || exhausted && priorReworks < run.budget.maxReworkPerGate) {
        throw new Error('Analysis gate does not assess its retained specialist report')
      }
      if (envelope.status === 'rework') {
        const defect = envelope.defect ?? (gate.stage === 'auditor' ? 'analysis' : 'report')
        const target = defect === 'scope' ? 'detective' : defect === 'plan' ? 'strategist'
          : defect === 'analysis' ? reportProducer(run.admission) : gate.stage
        if (gate.nextStage !== target || gate.defectClass !== (gate.decision === 'rework' ? defect : undefined)) {
          throw new Error('Analysis gate rework does not match the specialist defect and target')
        }
      }
      if (envelope.status === 'ready' && envelope.candidate !== undefined) {
        const captured: unknown = record.reportCandidates[candidateIndex++]
        if (!object(captured) || Object.keys(captured).sort().join(',') !== 'candidate,hash,producer,producerChildId'
          || captured.producer !== reportProducer(run.admission) || captured.producer !== envelope.stage
          || captured.hash !== reportHash(envelope.candidate)
          || JSON.stringify(captured.candidate) !== JSON.stringify(envelope.candidate)
          || !object(analysis) || analysis.mode !== 'producer' || analysis.childId !== captured.producerChildId
          || analysis.candidateHash !== captured.hash || typeof captured.producerChildId !== 'string'
          || captured.producerChildId.length === 0) {
          throw new Error('Conductor report candidate does not match its producer, child and exact content hash')
        }
        reconstructed.reportCandidates.push(captured as unknown as CapturedReport)
      }
      reportIndex++
      reconstructed.analysisReports.push(envelope)
    } else if (gate.decision === 'pass') {
      throw new Error('Analysis gate pass requires a retained specialist report')
    }
  }
  if (reportIndex !== run.analysisReports.length || candidateIndex !== run.reportCandidates.length
    || challengeIndex !== run.analysisChallenges.length) {
    throw new Error('Conductor analysis reports, candidates or challenges do not follow their evaluated gate history')
  }
  validateIntakeHistory(run)
  const last = run.history.findLast(gate => gate.kind === 'evaluated')
  const status = last === undefined ? 'running' : last.decision === 'pass'
    ? last.gate === 'G' ? 'reported' : 'running'
    : last.decision === 'rework' ? 'rework' : last.decision === 'abort' ? 'aborted' : 'escalated'
  if (run.status !== (ownerLifecycleStatus(run) ?? status)) throw new Error('Conductor analysis status does not match its last evaluated gate')
  if (run.reportDecision !== undefined) {
    const decision = run.reportDecision
    const problem = reportDecisionProblem(decision, run)
    const expectedDecision = decision.decision === 'accept' ? 'pass'
      : decision.decision === 'blocked' ? 'escalate' : last?.decision === 'escalate' ? 'escalate' : 'rework'
    const expectedBasis = decision.decision === 'revise' && last?.decision === 'escalate'
      ? [...decision.basis, `Gate G exhausted its ${run.budget.maxReworkPerGate} reworks per gate`]
      : decision.basis
    const revised = decision.decision === 'revise'
    const exhausted = revised && last?.decision === 'escalate'
    const previousGateGReworks = run.history.filter(gate => gate.kind === 'evaluated'
      && gate.gate === 'G' && gate.decision === 'rework').length
    if (problem !== undefined || last?.kind !== 'evaluated' || last.gate !== 'G' || last.stage !== 'arbiter'
      || last.decision !== expectedDecision || last.origin !== undefined || last.analysis !== undefined
      || revised && (last.nextStage !== reportProducer(run.admission)
        || (exhausted ? last.defectClass !== undefined || previousGateGReworks < run.budget.maxReworkPerGate
          : last.defectClass !== 'analysis'))
      || JSON.stringify(last.basis) !== JSON.stringify(expectedBasis)
      || JSON.stringify(last.evidenceReviewed) !== JSON.stringify(decision.evidence_reviewed)
      || last.stateUpdate !== `report ${decision.decision}`) {
      throw new Error('Conductor analysis report decision does not match its audit or final gate assessment')
    }
  }
  if (run.status === 'reported' && (run.currentStage !== 'report-complete' || run.reportDecision?.decision !== 'accept')) {
    throw new Error('Reported Conductor run requires report-complete and an accepted audited report')
  }
  return run
}
