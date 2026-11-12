/** Canonical filesystem path checks shared by Conductor capabilities. */

import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Resolve a path through its nearest existing ancestor.
 * @param cwd - absolute base directory for relative input.
 * @param path - absolute or base-relative path to canonicalize.
 * @returns canonical absolute path, including any nonexistent suffix.
 */
export function canonicalAbsolute(cwd: string, path: string): string {
  const absolute = resolve(cwd, isAbsolute(path) ? path : resolve(cwd, path))
  const remainder: string[] = []
  let existing = absolute
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) throw new Error(`no existing ancestor for ${absolute}`)
    remainder.unshift(relative(parent, existing))
    existing = parent
  }
  return resolve(realpathSync.native(existing), ...remainder)
}

/**
 * Test whether a canonical candidate is equal to or below a canonical root.
 * @param root - canonical absolute root.
 * @param candidate - canonical absolute path to test.
 * @returns true when the candidate stays inside the root.
 */
export function containsPath(root: string, candidate: string): boolean {
  const comparisonRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const comparisonCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  const suffix = relative(comparisonRoot, comparisonCandidate)
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
}
