/** Shared JSON predicates for model-authored and durable analysis reports. */

/**
 * Recognize an object record before reading report fields.
 * @param value - untrusted model or persisted JSON.
 * @returns whether value is a non-null, non-array object.
 */
export function reportObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recognize a normalized report string list; callers decide whether it may be empty.
 * @param value - untrusted report field.
 * @returns whether every member is a nonempty string without surrounding whitespace.
 */
export function reportTexts(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim() === item && item.length > 0)
}
