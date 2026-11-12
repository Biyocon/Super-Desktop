/** Durable, model-hidden Conductor child presentation. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ConductorChild } from './child-types.ts'
import { ANALYSIS_CHALLENGE_SCHEMA, analysisChallengeHash } from './analysis-challenge.ts'

const childSchema = z.object({
  childId: z.string(), runId: z.string(),
  role: z.enum(['detective', 'strategist', 'devils-advocate', 'headsman', 'auditor', 'integrator', 'arbiter', 'ralph']),
  mode: z.enum(['producer', 'critic']).optional(),
  attempt: z.number().int().positive(), historyOffset: z.number().int().nonnegative(),
  criticAttempt: z.number().int().positive().optional(),
  status: z.enum(['running', 'completed', 'failed']),
  gate: z.object({ id: z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G']), decision: z.enum(['pass', 'rework', 'escalate', 'abort']), reworks: z.number().int().nonnegative(), limit: z.number().int().positive(),
    challengeConclusion: z.enum(['holds', 'does_not_hold']).optional(),
    challenge: z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/), result: ANALYSIS_CHALLENGE_SCHEMA }).optional(),
  }).optional(),
}).superRefine((child, issue) => {
  if ((child.mode === 'critic') !== (child.criticAttempt !== undefined)) {
    issue.addIssue({ code: 'custom', message: 'critic mode requires one run-wide attempt' })
  }
  if (child.gate?.challengeConclusion !== undefined && child.mode !== 'critic') {
    issue.addIssue({ code: 'custom', message: 'only a critic child can carry a challenge conclusion' })
  }
  if (child.gate?.challenge !== undefined && child.gate.challengeConclusion === undefined) {
    issue.addIssue({ code: 'custom', message: 'challenge details require a validated conclusion' })
  }
  const captured = child.gate?.challenge
  if (captured !== undefined) {
    const result = captured.result
    if (result.run_id !== child.runId || result.critic_child_id !== child.childId
      || result.critic_attempt !== child.criticAttempt || result.conclusion !== child.gate?.challengeConclusion) {
      issue.addIssue({ code: 'custom', message: 'challenge identity does not match its child gate' })
    }
    let hash: string
    try { hash = analysisChallengeHash(result) } catch {
      // The structural schema already passed; the hash rejects invalid finding/material semantics.
      issue.addIssue({ code: 'custom', message: 'challenge semantics are invalid' })
      return
    }
    if (hash !== captured.hash) issue.addIssue({ code: 'custom', message: 'challenge digest does not match its validated result' })
  }
})

/** Durable parent projection; unrelated sessions and children are absent. */
export const conductorChildrenProjection: ProjectionDefinition<'conductorChildren', Record<string, ConductorChild>> = {
  key: 'conductorChildren',
  schema: z.record(z.string(), childSchema) as unknown as z.ZodType<Record<string, ConductorChild>>,
  init: () => ({}),
  apply: (state, event) => event.type === 'session/end-seed' ? {} : event.type === 'conductor/child' ? { ...state, [event.data.childId]: event.data } : state,
  view: state => state,
  stateVersion: 3,
}
