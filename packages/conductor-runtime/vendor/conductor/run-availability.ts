/** Read-only availability of saved Conductor runs, without exposing record content. */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { UnavailableRunView } from './run-availability-types.ts'
import { inspectRunRecord } from './persistence.ts'

/** The latest checkpoint for each run determines whether it is usable. */
export const conductorUnavailableRunsProjection: ProjectionDefinition<'conductorUnavailableRuns', Record<string, UnavailableRunView>> = {
  key: 'conductorUnavailableRuns',
  schema: z.record(z.string(), z.object({ format: z.number().int().nullable() })),
  init: () => ({}),
  apply: (state, event) => {
    if (event.type !== 'conductor/checkpoint') return state
    const runId = event.data.runId
    const withoutRun = (): Record<string, UnavailableRunView> =>
      Object.hasOwn(state, runId) ? Object.fromEntries(Object.entries(state).filter(([key]) => key !== runId)) : state
    if (event.data.record === null) return withoutRun()
    const inspected = inspectRunRecord(runId, event.data.record)
    return inspected.kind === 'unavailable' ? { ...state, [runId]: { format: inspected.format } } : withoutRun()
  },
  view: state => state,
  stateVersion: 1,
}
