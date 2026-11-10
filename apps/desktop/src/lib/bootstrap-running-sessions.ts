/** Main owns live turns; a renderer reload must not infer liveness from history.
 * Events received during bootstrap take precedence over the earlier snapshot. */
export function bootstrapRunningSessions(
  current: Record<string, boolean>,
  activeTurnIds?: Record<string, string>,
): Record<string, boolean> {
  return {
    ...Object.fromEntries(Object.keys(activeTurnIds ?? {}).map(id => [id, true])),
    ...current,
  };
}
