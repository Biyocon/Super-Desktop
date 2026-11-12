/** Model-hidden, read-only status for saved Conductor runs that cannot be used. */
export interface UnavailableRunView {
  /** Parsed record format, or null when the record has no usable format number. */
  format: number | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Only unavailable run ids; current runs have no entry. */
    conductorUnavailableRuns: Record<string, UnavailableRunView>
  }
}
