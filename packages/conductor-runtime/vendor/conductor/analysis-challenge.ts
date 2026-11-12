/** Validation and hashing for a future, candidate-bound analysis challenge. */
import { z } from 'zod'
import { contentHash } from './intake.ts'
import type { ConductorEntry, ConductorMaterialId, ReportDeliverable, SpecialistProblem } from './types.ts'

const normalized = z.string().min(1).refine(value => value.trim() === value)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const materialId = normalized.transform(value => value as ConductorMaterialId)
const findingSchema = z.strictObject({
  id: normalized,
  severity: z.enum(['minor', 'major', 'critical']),
  claim: normalized,
  rationale: normalized,
  material_ids: z.array(materialId),
})
const fields = {
  run_id: normalized,
  purpose: z.literal('analysis'),
  candidate_hash: hash,
  candidate_version: normalized,
  material_ids: z.array(materialId).min(1),
  critic_child_id: normalized,
  critic_attempt: z.int().positive(),
  findings: z.array(findingSchema),
  summary: normalized,
}

/** Strict structured output for a critic; only a failed challenge carries a defect class. */
export const ANALYSIS_CHALLENGE_SCHEMA = z.discriminatedUnion('conclusion', [
  z.strictObject({ ...fields, conclusion: z.literal('holds') }),
  z.strictObject({ ...fields, conclusion: z.literal('does_not_hold'), defect: z.enum(['scope', 'plan', 'report']) }),
])

/** One validated reasoning challenge of an immutable report candidate. */
export type AnalysisChallenge = z.infer<typeof ANALYSIS_CHALLENGE_SCHEMA>

/** A prior, already accepted challenge and its runtime-owned digest. */
export interface CapturedChallengeIdentity {
  challenge: AnalysisChallenge
  hash: string
}

/** Dispatch facts against which untrusted critic output is checked. */
export interface AnalysisChallengeContext {
  runId: string
  candidateHash: string
  candidateVersion: string
  materialIds: readonly ConductorMaterialId[]
  criticChildId: string
  producerChildId: string
  /** P2 must assign strictly increasing attempts across the whole run, never reset per candidate. */
  criticAttempt: number
  dispatchMode: 'producer' | 'critic'
  entry: ConductorEntry
  deliverable: ReportDeliverable
  producer: ConductorEntry
  maxSummaryCharacters: number
  previous: readonly CapturedChallengeIdentity[]
}

function canonicalChallenge(challenge: AnalysisChallenge): string {
  return JSON.stringify({
    run_id: challenge.run_id,
    purpose: challenge.purpose,
    candidate_hash: challenge.candidate_hash,
    candidate_version: challenge.candidate_version,
    material_ids: challenge.material_ids,
    critic_child_id: challenge.critic_child_id,
    critic_attempt: challenge.critic_attempt,
    findings: challenge.findings.map(finding => ({
      id: finding.id,
      severity: finding.severity,
      claim: finding.claim,
      rationale: finding.rationale,
      material_ids: finding.material_ids,
    })),
    conclusion: challenge.conclusion,
    ...challenge.conclusion === 'does_not_hold' ? { defect: challenge.defect } : {},
    summary: challenge.summary,
  })
}

function semanticProblem(challenge: AnalysisChallenge): string | undefined {
  if (new Set(challenge.material_ids).size !== challenge.material_ids.length) {
    return 'analysis challenge material IDs must be unique'
  }
  if (new Set(challenge.findings.map(finding => finding.id)).size !== challenge.findings.length) {
    return 'analysis challenge finding IDs must be unique'
  }
  if (challenge.findings.some(finding => new Set(finding.material_ids).size !== finding.material_ids.length
    || finding.material_ids.some(id => !challenge.material_ids.includes(id)))) {
    return 'analysis challenge findings need unique references to their own materials'
  }
  const substantive = challenge.findings.some(finding => finding.severity === 'major' || finding.severity === 'critical')
  if (challenge.conclusion === 'holds' && substantive) return 'holds cannot carry unresolved major or critical findings'
  if (challenge.conclusion === 'does_not_hold' && !substantive) return 'does_not_hold requires a major or critical finding'
  return undefined
}

/**
 * Hash the exact validated challenge content in a fixed field order.
 * @param challenge - validated challenge.
 * @returns lowercase SHA-256 digest.
 */
export function analysisChallengeHash(challenge: AnalysisChallenge): string {
  const parsed = ANALYSIS_CHALLENGE_SCHEMA.parse(challenge)
  const problem = semanticProblem(parsed)
  if (problem !== undefined) throw new Error(problem)
  return contentHash(canonicalChallenge(parsed))
}

/**
 * Check critic output against the dispatched candidate and prior accepted challenges.
 * @param value - untrusted structured output.
 * @param context - runtime-owned dispatch identity, materials and challenge lineage.
 * @returns the parsed challenge and runtime hash, or a classified problem.
 */
export function validateAnalysisChallenge(value: unknown, context: AnalysisChallengeContext):
  | { challenge: AnalysisChallenge; hash: string; reworkTarget: ConductorEntry | undefined; problem?: never }
  | { problem: SpecialistProblem; challenge?: never; hash?: never; reworkTarget?: never } {
  const report = (message: string) => ({ problem: { kind: 'report' as const, message } })
  const authority = (message: string) => ({ problem: { kind: 'authority' as const, message } })
  if (!Number.isSafeInteger(context.maxSummaryCharacters) || context.maxSummaryCharacters <= 0) {
    throw new Error('AnalysisChallenge maxSummaryCharacters must be a positive safe integer')
  }
  const expectedProducer = context.entry === 'detective' && context.deliverable === 'recommendations'
    ? 'strategist' : context.entry
  if (context.producer !== expectedProducer) throw new Error('AnalysisChallenge context producer does not match admitted entry and deliverable')
  if (context.producerChildId === context.criticChildId) return authority('critic child must differ from producer child')
  if (context.dispatchMode !== 'critic') return authority('analysis challenge requires a critic dispatch')
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const identity = value as Record<string, unknown>
    if (typeof identity.run_id === 'string' && identity.run_id !== context.runId) return authority('analysis challenge belongs to another run')
    if (typeof identity.purpose === 'string' && identity.purpose !== 'analysis') return authority('analysis challenge has another purpose')
    if (typeof identity.candidate_hash === 'string' && identity.candidate_hash !== context.candidateHash) return authority('analysis challenge references a stale candidate hash')
    if (typeof identity.candidate_version === 'string' && identity.candidate_version !== context.candidateVersion) return authority('analysis challenge references a stale candidate version')
    if (typeof identity.critic_child_id === 'string' && identity.critic_child_id !== context.criticChildId) return authority('analysis challenge belongs to another critic child')
    if (typeof identity.critic_attempt === 'number' && identity.critic_attempt !== context.criticAttempt) return authority('analysis challenge belongs to another critic attempt')
  }
  const parsed = ANALYSIS_CHALLENGE_SCHEMA.safeParse(value)
  if (!parsed.success) return report('malformed AnalysisChallenge result')
  const challenge = parsed.data
  if (challenge.summary.length > context.maxSummaryCharacters) return report('analysis challenge summary exceeds the configured character limit')
  const semantic = semanticProblem(challenge)
  if (semantic !== undefined) return report(semantic)
  if (challenge.material_ids.length !== context.materialIds.length
    || challenge.material_ids.some((id, index) => id !== context.materialIds[index])) {
    return report('analysis challenge requires the candidate material IDs in order')
  }
  if (challenge.conclusion === 'does_not_hold' && challenge.defect === 'scope' && context.entry !== 'detective') {
    return report('Detective is not on the admitted route for scope rework')
  }
  if (challenge.conclusion === 'does_not_hold' && challenge.defect === 'plan'
    && !(context.entry === 'strategist' || (context.entry === 'detective' && context.deliverable === 'recommendations'))) {
    return report('Strategist is not on the admitted route for plan rework')
  }
  for (const previous of context.previous) {
    const parsedPrevious = ANALYSIS_CHALLENGE_SCHEMA.safeParse(previous.challenge)
    if (!parsedPrevious.success) return authority('stored analysis challenge is malformed')
    const previousSemantic = semanticProblem(parsedPrevious.data)
    if (previousSemantic !== undefined) return authority(`stored analysis challenge is semantically invalid: ${previousSemantic}`)
    if (previous.hash !== analysisChallengeHash(parsedPrevious.data)) return authority('stored analysis challenge hash disagrees with its content')
    if (previous.challenge.critic_child_id === challenge.critic_child_id) return authority('critic child was already used')
    if (previous.challenge.critic_attempt >= challenge.critic_attempt) {
      return authority('critic attempt must increase across the whole run')
    }
    if (previous.challenge.candidate_hash === challenge.candidate_hash) return authority('candidate already has an accepted challenge')
  }
  const reworkTarget = challenge.conclusion === 'holds' ? undefined
    : challenge.defect === 'scope' ? 'detective'
      : challenge.defect === 'plan' ? 'strategist' : context.producer
  return { challenge, hash: analysisChallengeHash(challenge), reworkTarget }
}
