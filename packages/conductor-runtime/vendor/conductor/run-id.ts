/**
 * Conductor run-id minting and validation.
 *
 * A run id is `CON-YYYY-NNNN`: the minting year plus a 4-digit sequence. Ids
 * are opaque cross-boundary tokens branded as {@link ConductorRunId}; the
 * pattern is a containment rule for resume and store keys, not a secrecy
 * mechanism.
 *
 * @module @deepseek-ai/dsh-conductor/run-id
 */

import { randomInt } from 'node:crypto'
import { ConductorRunId } from './types.ts'

const RUN_ID_PATTERN = /^CON-\d{4}-\d{4}$/

/**
 * Mint a new run id.
 * @param now - the date whose year stamps the id; defaults to the current date.
 * @param sequence - the 1..9999 sequence, zero-padded to 4 digits; defaults to a
 *   random value. Callers that need collision safety re-mint when the store
 *   already holds the id.
 * @returns the branded id.
 */
export function mintRunId(now: Date = new Date(), sequence: number = randomInt(1, 10_000)): ConductorRunId {
  return ConductorRunId(`CON-${now.getFullYear()}-${String(sequence).padStart(4, '0')}`)
}

/**
 * Whether a string is a well-formed Conductor run id.
 * @param id - the candidate id.
 * @returns true iff the id matches `CON-YYYY-NNNN`.
 */
export function isValidRunId(id: string): boolean {
  return RUN_ID_PATTERN.test(id)
}
