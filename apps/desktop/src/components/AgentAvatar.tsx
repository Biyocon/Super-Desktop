// Kombi patch on the PI-Desktop baseline: per-agent avatars in the delegation
// views. The main agent is the Conductor; each delegate resolves to the
// Conductor role whose mandate matches its work, so every agent busy on a
// task is recognisable at a glance.
//
// Built-in delegate ids map to roles with the same mandate:
//   explorer      -> detective       (afklar, find og dokumentér evidens)
//   code-reviewer -> devils-advocate (falsificerbar kritik af leverancen)
//   test-runner   -> auditor         (reproducerbar verifikation)
//   fixer         -> headsman        (implementér mod baseline)
//
// A user-defined delegate named after a role (`detective`, `strategist`, … or
// `conductor-detective`, …) resolves to that role's image. Anything else falls
// back to the generic bot glyph, so an unknown agent still reads correctly.

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

/**
 * The full Conductor role set, in workflow order. `SubagentTopology` renders
 * this whole team (dimmed), then highlights the roles actually in use.
 */
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
 * Resolve an arbitrary agent name to a Conductor role id, or `undefined` when
 * the name is outside the role set. This is `avatarUrlFor` minus the asset
 * lookup, so the team view and the per-agent avatar stay on one path.
 */
export function resolveRoleId(agentName: string | undefined): ConductorRole | undefined {
  if (!agentName) return undefined;
  const id = normalizeSubagentName(agentName)
    .replace(/^conductor-/, "")
    .replace(/['\u2019]/g, "");
  const role = BUILTIN_ROLE_ALIASES[id] ?? id;
  return CONDUCTOR_ROLES.includes(role as ConductorRole) ? (role as ConductorRole) : undefined;
}

/** Built-in delegate ids mapped to the Conductor role with the same mandate. */
const BUILTIN_ROLE_ALIASES: Record<string, string> = {
  explorer: "detective",
  "code-reviewer": "devils-advocate",
  "test-runner": "auditor",
  fixer: "headsman",
};

/**
 * Delegate id (or Conductor role id) to its avatar asset, if one exists.
 *
 * Uses the canonical `normalizeSubagentName` from `@pi-desktop/shared` — the
 * same function the runtime uses to turn a definition file (or frontmatter
 * name) into a Task argument. Normalizing identically here means the avatar
 * lookup can never drift from the id the UI actually receives, and it strips
 * paths and `.md` for free (`/…/Code_Reviewer.md` -> `code-reviewer`).
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
  return ROLE_AVATARS[BUILTIN_ROLE_ALIASES[id] ?? id];
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

/** The coordinating session agent: the Conductor of the role set. */
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