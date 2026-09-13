import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  AgentAvatar,
  CONDUCTOR_ROLES,
  ConductorAvatar,
  resolveRoleId,
} from "../../../components/AgentAvatar";
import {
  summarizeSubagentActivity,
  type DelegationActivityItem,
  type SubagentOutcome,
  type SubagentTiming,
} from "../../../lib/subagent-topology";
import { ToolRow } from "./ToolRow";
import { delegateAgentName } from "./model";

/**
 * A truthful one-level graph of one parent fan-out (ADR 0062).
 *
 * The runtime has no delegate-to-delegate edges, so this deliberately stops at
 * main agent -> Task nodes instead of implying dependencies that do not exist.
 */
export function SubagentTopology({
  items,
  delegationStatuses,
  delegationTimings,
  onUserInteraction,
}: {
  items: DelegationActivityItem[];
  delegationStatuses?: ReadonlyMap<string, SubagentOutcome>;
  delegationTimings?: ReadonlyMap<string, SubagentTiming>;
  onUserInteraction?: () => void;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const summary = summarizeSubagentActivity(items, delegationStatuses);

  // Always show the complete Conductor team. A role with a matching Task
  // renders its live ToolRow; roles not used in this run remain visible but
  // dimmed, so the user can see both the team and the active participants.
  const itemsByRole = useMemo(() => {
    const map = new Map<string, DelegationActivityItem>();
    for (const item of items) {
      const name = delegateAgentName(item.message, item.delegate);
      const role = resolveRoleId(name);
      if (role && !map.has(role)) map.set(role, item);
    }
    return map;
  }, [items]);

  return (
    <section className="subagent-topology" aria-labelledby={labelId}>
      <div className="subagent-topology-root">
        <span className="subagent-topology-root-icon" aria-hidden>
          <ConductorAvatar size={28} />
        </span>
        <span className="subagent-topology-root-copy">
          <strong id={labelId}>{t("chat.subagentCoordinator")}</strong>
          <span>
            {t("chat.subagentCoordinating", { count: summary.total })}
          </span>
        </span>
      </div>
      <span className="subagent-topology-connector" aria-hidden />
      <div
        className="subagent-topology-agents"
        role="list"
        aria-label={t("chat.subagentTopology")}
      >
        {CONDUCTOR_ROLES.filter((role) => role !== "conductor").map((role) => {
          const item = itemsByRole.get(role);
          if (item) {
            return (
              <ToolRow
                key={item.message.id}
                message={item.message}
                {...(item.delegate ? { delegate: item.delegate } : {})}
                variant="topology"
                onUserInteraction={onUserInteraction}
                {...(delegationStatuses ? { delegationStatuses } : {})}
                {...(delegationTimings ? { delegationTimings } : {})}
              />
            );
          }
          return (
            <div
              key={role}
              className="subagent-topology-node subagent-topology-idle"
              role="listitem"
              aria-label={role}
            >
              <span className="subagent-topology-avatar" aria-hidden>
                <AgentAvatar agentName={role} size={28} />
              </span>
              <span className="subagent-topology-node-copy">
                <span className="subagent-topology-node-title">{role}</span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
