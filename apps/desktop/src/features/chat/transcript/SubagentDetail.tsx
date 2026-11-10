import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  AgentAvatar,
  CONDUCTOR_ROLES,
  ConductorAvatar,
  resolveRoleId,
} from "../../../components/AgentAvatar";
import {
  latestDelegationItems,
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

  // Role order is stable, but each independent Task keeps its own identity.
  // Earlier calls in a resumed chain remain history, not extra active cards.
  const itemsByRole = useMemo(() => {
    const map = new Map<string | undefined, DelegationActivityItem[]>();
    for (const item of latestDelegationItems(items)) {
      const role = resolveRoleId(delegateAgentName(item.message, item.delegate));
      const group = map.get(role) ?? [];
      group.push(item);
      map.set(role, group);
    }
    return map;
  }, [items]);
  const renderTask = (item: DelegationActivityItem) => (
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
          const roleItems = itemsByRole.get(role);
          if (roleItems) return roleItems.map(renderTask);
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
        {itemsByRole.get(undefined)?.map(renderTask)}
        {itemsByRole.get("conductor")?.map(renderTask)}
      </div>
    </section>
  );
}
