import { MAX_SUBAGENT_DEFINITIONS, type UserSubagentRecord } from "@pi-desktop/shared";

type UserSelection = Pick<UserSubagentRecord, "id" | "name" | "enabled">;

/** Only registry/library handles spend user slots; shipped builtins never do. */
export function activeUserSubagentHandles(records: readonly UserSelection[]): Set<string> {
  return new Set(records.filter((row) => row.enabled).map((row) => row.name || row.id));
}

/** Duplicates still reach the host's authoritative source-conflict validation. */
export function userSubagentAtLimit(records: readonly UserSelection[], candidate: UserSelection): boolean {
  const handles = activeUserSubagentHandles(records);
  return !handles.has(candidate.name || candidate.id) && handles.size >= MAX_SUBAGENT_DEFINITIONS;
}
