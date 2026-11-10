import type { MiniActivity } from "@pi-desktop/shared";
import type { AppState } from "../../stores/app-state";
import { headAsk } from "../../lib/pending-asks";
import { headPermission } from "../../lib/pending-permissions";

export function projectMiniActivity(state: Pick<AppState, "activeSessionId" | "sessions" | "pendingPermissions" | "pendingAsks" | "pendingPlans" | "runningSessions" | "sessionOutcomes">): MiniActivity {
  const id = state.activeSessionId;
  const session = state.sessions.find((candidate) => candidate.id === id);
  if (!id || !session) return { sessionId: null, title: "", status: "idle" };
  const status = headPermission(state.pendingPermissions, id) || headAsk(state.pendingAsks, id) ? "waiting" :
    state.pendingPlans[id]?.status === "pending" ? "review" : state.runningSessions[id] ? "running" :
      state.sessionOutcomes[id] === "failed" ? "failed" : "idle";
  return { sessionId: id, title: session.title.slice(0, 160), status };
}
