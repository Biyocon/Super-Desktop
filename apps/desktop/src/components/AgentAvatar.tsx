// Agent-name portraits are decorative, not evidence of a Conductor role.
// Only explicit role names resolve to portraits; generic builtins and unknown
// agents keep the bot glyph. Authoritative Conductor UI uses roleAvatarUrl.

import { normalizeSubagentName } from "@pi-desktop/shared";

import conductorUrl from "../assets/agent-avatars/conductor.png";
import detectiveUrl from "../assets/agent-avatars/detective.png";
import strategistUrl from "../assets/agent-avatars/strategist.png";
import devilsAdvocateUrl from "../assets/agent-avatars/devils-advocate.png";
import headsmanUrl from "../assets/agent-avatars/headsman.png";
import auditorUrl from "../assets/agent-avatars/auditor.png";
import integratorUrl from "../assets/agent-avatars/integrator.png";
import arbiterUrl from "../assets/agent-avatars/arbiter.png";
import { IconBot } from "./icons";

const ROLE_AVATARS: Record<string, string> = {
  conductor: conductorUrl,
  detective: detectiveUrl,
  strategist: strategistUrl,
  "devils-advocate": devilsAdvocateUrl,
  devilsadvocate: devilsAdvocateUrl,
  headsman: headsmanUrl,
  auditor: auditorUrl,
  integrator: integratorUrl,
  arbiter: arbiterUrl,
  "the-arbiter": arbiterUrl,
};

/** The authoritative Conductor role set, in workflow order. */
export const CONDUCTOR_ROLES = [
  "conductor",
  "detective",
  "strategist",
  "devils-advocate",
  "headsman",
  "auditor",
  "integrator",
  "arbiter",
] as const;

export type ConductorRole = (typeof CONDUCTOR_ROLES)[number];

/** Canonical avatar asset for a role id (no name normalisation applied). */
export function roleAvatarUrl(role: ConductorRole): string {
  return ROLE_AVATARS[role];
}

/**
 * Resolve an explicit role name for decoration only. Generic builtin names
 * never establish role identity or authority.
 */
export function resolveRoleId(agentName: string | undefined): ConductorRole | undefined {
  if (!agentName) return undefined;
  const id = normalizeSubagentName(agentName)
    .replace(/^conductor-/, "")
    .replace(/['\u2019]/g, "");
  return CONDUCTOR_ROLES.includes(id as ConductorRole) ? (id as ConductorRole) : undefined;
}

/**
 * Explicit role name to its decorative avatar asset, if one exists.
 *
 * Uses the canonical `normalizeSubagentName` from `@pi-desktop/shared` — the
 * same function the runtime uses to turn a definition file (or frontmatter
 * name) into a Task argument. Normalizing identically here means the avatar
 * lookup can never drift from the id the UI actually receives, and it strips
 * paths and `.md` for free (`/…/Detective.md` -> `detective`).
 *
 * The canonical normalizer keeps apostrophes, so a definition named
 * `Devil's Advocate.md` becomes `devil's-advocate` — an id the asset is not
 * filed under. We drop apostrophes before the lookup so the role still
 * resolves; every other separator is left to the canonical function.
 */
function avatarUrlFor(agentName: string | undefined): string | undefined {
  if (!agentName) return undefined;
  const id = normalizeSubagentName(agentName)
    .replace(/^conductor-/, "")
    .replace(/['\u2019]/g, "");
  return Object.prototype.hasOwnProperty.call(ROLE_AVATARS, id) ? ROLE_AVATARS[id] : undefined;
}


/**
 * One delegate's avatar, at the size of the icon it replaces. Unknown agents
 * keep the generic bot glyph so their row still reads without an image.
 */
export function AgentAvatar({
  agentName,
  size,
}: {
  agentName?: string;
  size: number;
}) {
  const url = avatarUrlFor(agentName);
  if (!url) return <IconBot size={size} aria-hidden />;
  return (
    <img
      className="agent-avatar"
      src={url}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}

/** Portrait for an explicitly authoritative Conductor, not a generic parent. */
export function ConductorAvatar({ size }: { size: number }) {
  return (
    <img
      className="agent-avatar"
      src={conductorUrl}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}