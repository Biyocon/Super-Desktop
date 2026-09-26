import {
  fallbackBuiltinDefinitions,
  type SubagentDefinition,
  type UserSubagentRecord,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";

/**
 * One shipped default plus whether this installation still offers it.
 *
 * A switched-off builtin stays in the list on purpose: it has no document to
 * delete, so its row and its switch are the only way back on.
 */
export type BuiltinSubagentRow = SubagentDefinition & { enabled: boolean };

/** User-owned registry/library documents plus shipped defaults. */
export type SubagentPageData = {
  owned: UserSubagentRecord[];
  library: UserSubagentRecord[];
  builtins: BuiltinSubagentRow[];
};

export const EMPTY_SUBAGENT_PAGE: SubagentPageData = {
  owned: [],
  library: [],
  builtins: [],
};

/**
 * Settings lists three sources: writable registry files, the read-only
 * CustomAgents library, and shipped defaults. Catalog load failures must not
 * hide either user-owned source; builtins fall back to the shared preset
 * catalog and are reported enabled when their host state is unavailable.
 */
export async function fetchSubagentPageData(): Promise<SubagentPageData> {
  const ownedResult = await api.listUserSubagents({ level: "global" });
  const records = ownedResult.subagents ?? [];
  const owned = records.filter((row) => row.source !== "customagents");
  const library = records.filter((row) => row.source === "customagents");
  const enabledHandles = new Set(
    records.filter((row) => row.enabled).map((row) => row.name || row.id),
  );
  try {
    const catalog = await api.subagentCatalog();
    // Older main processes answer without `builtins`; derive the group from the
    // effective catalog then, which is how this page read it before builtins
    // could be switched off at all.
    const builtins =
      catalog.builtins ??
      (catalog.subagents ?? [])
        .filter((item) => item.source === "builtin")
        .map((item) => ({ ...item, enabled: true }));
    return {
      owned,
      library,
      builtins: builtins.filter(
        (item) => item.source === "builtin" && !enabledHandles.has(item.name),
      ),
    };
  } catch {
    return {
      owned,
      library,
      builtins: fallbackBuiltinDefinitions()
        .map((item) => ({ ...item, enabled: true }))
        .filter((item) => !enabledHandles.has(item.name)),
    };
  }
}
