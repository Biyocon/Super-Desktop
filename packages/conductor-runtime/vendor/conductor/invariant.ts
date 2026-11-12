/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-conductor`.
 * @module @deepseek-ai/dsh-conductor/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { inspectRunRecord } from './persistence.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-conductor'

/** Cordis companion plugin name. */
export const name = 'conductor-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

function validateCheckpoint(event: SessionEvent, fail: InvariantFailure, existing: boolean): void {
  if (event.type !== 'conductor/checkpoint' || event.data.record === null) return
  const inspected = inspectRunRecord(event.data.runId, event.data.record)
  if (inspected.kind === 'unavailable' && !existing) {
    fail(`invalid conductor checkpoint for run ${JSON.stringify(event.data.runId)} (format ${inspected.format ?? 'unknown'})`)
  }
}

/** Permit unavailable existing checkpoints while rejecting invalid new writes. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateCheckpoint(event, fail, true)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [unknown, SessionEvent])[1]
    validateCheckpoint(event, fail, false)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
