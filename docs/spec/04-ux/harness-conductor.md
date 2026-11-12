# Harness Conductor in chat

## Authority and entry

Each retained desktop chat has an **Open Conductor** button above its ordinary
transcript. This is a dedicated process surface, not a Task alias or an external
MCP result. Closing the panel does not cancel a host-owned run. Opening it reads
history; it never starts or resumes work. The chat's durable session owns the
repository and provider selection. Native/remote sessions and sessions without a
repository cannot start a run here.

The Emperor means the user granting a bounded mandate. The Conductor coordinates
the actual Harness handovers. A role reference displays the existing portraits
for The Conductor, Detective, Strategist, Devil’s Advocate, Headsman, Auditor,
Integrator and The Arbiter. The reference is explicitly not a list of running
workers. Ralph appears only when an acknowledged Ralph dispatch exists, as the
Headsman's subordinate implementation loop.

Generic Tasks remain generic: builtins use their own exact names and a bot glyph,
not inferred Conductor roles. Only actual Task nodes appear; independent and
repeated tasks remain separate, while a resumed chain selects its latest card
without rewriting older transcript rows. Explicit role-name portraits on ordinary
user agents are decoration, never process authority.

## Mandate form

**New run** offers read-only analysis or authorized implementation, an objective,
read scope, excluded paths, acceptance criteria and optional input material paths.
Implementation also requires permitted write paths and fixed verification command
IDs. Multi-entry fields use one item per line. Paths are repository-relative,
use `/`, and cannot contain wildcards, parent traversal, aliases or `.git`.
Main, runtime and host independently validate the submitted mandate; the renderer
cannot choose an executable, container image, project path or provider credential.

The initial fixed catalog is `node-tests`, using a cached digest-pinned Linux
Node image with `/usr/local/bin/node --test --test-isolation=none`. It does not
pull images or install Docker. The repository mount is read-only to verification
processes, with default-deny seccomp and no network. This is a narrow initial
catalog, not arbitrary project-command support. Missing local prerequisites
block implementation rather than weakening confinement.

Starting reserves one request UUID and disables duplicate submissions. **Cancel
pending entry** cancels that exact admission, including an outstanding material
Read permission. Existing ordinary chat work and another active Conductor entry
block a competing start. The host remains authoritative even if UI metadata is
stale.

## Process and evidence

The selected run shows its actual host lifecycle, engine status, current stage
and gate, record format, source baseline, version and next transition. A displayed
transition is explanatory; it cannot advance the engine. Engine provenance shows
the source revision, runtime version, MIT license, format 5 and artifact hashes.
Missing or incompatible engine artifacts give a visible blocking message. There
is no fallback to ordinary model conversation.

Workers come only from acknowledged dispatch records. Each card keeps role,
worker identity, dispatch identity, task, mode, input hash, lifecycle and raw
output separate. A completed worker is not a passed gate. Independent dispatches
are keyed by dispatch ID, even when they reuse a worker identity.

Gate disclosures show the engine's actual decision, basis, reviewed evidence,
state update, next stage, defect class and baseline hash when present. Explicit
analysis skips are labeled skipped/not applicable, with the engine's reason,
not passed. Rework history remains visible, including downstream invalidation.
Reports show their exact saved JSON separately from worker output. The Arbiter's
GO/NO-GO or analysis accept/revise/blocked is copied from its motor record into
the overview; it is never inferred from prose. Raw saved checkpoint/intake JSON
remains inspectable for diagnostics.

In the pinned format-5 driver, a valid NO-GO is retained as the exact authoritative
Gate-G escalation (`arbiter NO-GO — escalate to owner`), not `run.decision`.
Only that gate record can project NO-GO when the decision field is absent;
the same words in worker output or another escalation cannot do so.

All disclosures use shared native buttons with `aria-expanded` and matching
`aria-controls`; mouse, Enter and Space operate the same panel. Status text does
not rely on color. All interface text uses the nine shipped i18n catalogs.
Untrusted source/report strings render as text, not executable HTML.

## Exact Gate-C decision and permissions

At the actual owner wait, the panel presents the exact consent request ID,
execution baseline hash, source fingerprint, scope/plan/acceptance versions,
allowed/excluded paths, rollback reference, quality definition hashes and effect
profile. **Approve this exact baseline** and **Deny this baseline** answer only
that request. Neither button optimistically passes a gate or caches a grant.
A changed/stale/wrong-run request is rejected. Existing file-tool permissions
remain separate, and ordinary permission mode, sensitive paths and audit rules
still apply to implementation writes.

GO is not authorization to commit, push, merge, release, publish or deploy. An
`awaiting_authorization` engine is not falsely labeled closed. This integration
does not provide external-action execution or a generic owner-directive editor.
An escalation that needs an unsupported owner intervention remains visible and
blocked; it is not converted into consent or a fabricated transition.

## History and lifecycle

Rust owns durable runs, reports, gate checkpoints, dispatch receipts and source
lineage. Renderer subscriptions are invalidations only. The controller coalesces
reads, rejects stale owner/run/selection/version responses and never replays
provider calls, writes or dispatches on mount, reopen or reload. Disposed listeners
cannot update another session's panel. Reconnecting an effect generation waits
out an older read and then refreshes the current generation.

Cancellation awaits owned resources. Interrupted history offers **Validate
baseline and resume** only when the projection identifies that option. Resume
uses the exact observed version, revalidates source/baseline and requires fresh
Gate-C consent where applicable. Cleanup issues are visible and block resume.
A source-effect acknowledgement failure does not mean the write was rolled back.

## Verification status

Component tests cover panel entry, exact consent display, role/worker separation,
matching gate/report disclosures, missing-engine blocking and observational
reopening. Controller tests cover duplicate clicks/invalidations, stale replies,
selection changes, disposal/reconnect and exact consent identity. Local API-chain
acceptance separately exercises actual preload/main/provider resolution, packaged
sidecar, unchanged Harness, Rust persistence, a harmless write and independent
Docker verification. These are fixture tests, not live-model-quality acceptance.
Isolated whole-app fixture acceptance has also passed: actual form entry and
Gate-C approval, 41 native mouse/Enter/Space disclosure interactions, ten
screenshot hashes, renderer reload and full owned-app relaunch with identical
saved history and no provider/dispatch/write replay. This does not certify live
model quality. Final committed-candidate and fork integration qualification are
recorded separately in the [acceptance matrix](../../project/harness-conductor-acceptance.md).
