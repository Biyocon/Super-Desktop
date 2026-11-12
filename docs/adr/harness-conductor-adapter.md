# ADR: Harness Conductor adapter

- Status: Proposed

Implementation is in progress; complete product acceptance is pending.

## Context

Generic Task delegation, portrait aliases and external MCP tools do not establish
an authoritative Conductor run. The user has authorized a distinct integration
supporting analysis and scoped implementation without changing the existing MCP
pilot. The external diagrams describe the intended authority and handoffs, not
runtime evidence.

## Decision

Reuse the unchanged MIT-licensed Harness Conductor driver at source revision
`879ab27bdd22203675d6f0cc678652779fc089cd` (package `0.1.0-rc.7`, record format 5).
Vendor only tracked engine sources and the existing capability/path guards with
an exact file/hash manifest and the copyright notice. Build from these sources,
not an ignored developer `lib` directory. Ordinary builds must not consult a
private checkout or fetch a floating runtime. Missing/incompatible artifacts fail
visibly; there is no generic-chat fallback.

A separate Node adapter owns specialist dispatch and external service boundaries.
Harness owns admission, report validation, gate decisions, prerequisite order,
rework invalidation and final outcomes. Do not implement another gate state
machine. The adapter must preserve host tool permissions and apply the unchanged
Harness capability filters and argument guards at execution, not just in prompts.
The Emperor is the user mandate, not a worker. Ralph is an optional subordinate
implementation loop; generic Tasks retain their existing identity and semantics.

Renderer -> allowlisted preload -> thin main orchestration -> Rust host and Node
runtime remains the process model. Rust owns persistent records and process-epoch
interruption; runtime checkpoints and dispatch journals are versioned projections
with run/stage/dispatch lineage. Reading history must never dispatch work. Resume
requires an explicit user action, current source/baseline validation and Harness'
resume/owner-ledger rules. A GO awaiting authorization is not a closed run and
never authorizes commit, merge, deployment or publication.

Quality commands are host-resolved immutable catalog entries, not arbitrary
model-generated shell text. Gate C binds their definitions and user-approved
scope; fresh D/E evidence is produced by actual confined processes and bound to
the current dispatch. An unavailable full-enforcement sandbox blocks commands.
A custom isolated runner may be used only with independently tested filesystem
and network confinement; never relabel a partial backend as full.

The initial compatible runner targets cached, digest-pinned Node Linux images on
the local Docker engine. It uses an empty task-owned Docker configuration,
`--pull never`, a read-only repository mount, default-deny syscalls, denied TCP
and Unix sockets, no capabilities and bounded resources. An independent probe
against an owned mount must pass before the repository is exposed. Quality
commands have no repository write capability; implementation writes remain
host-tool operations subject to both Harness guards and existing permissions.

Pinned record format 5 rejects the driver's infrastructure-failure checkpoint
when it contains quality cycles without a documented gate attempt. Therefore
unjudged process evidence remains in the separate host dispatch journal on
failure, while the last valid engine checkpoint is retained. It is not injected
into a later worker's evidence or used to fabricate a gate decision. Actual
process acceptance covers this failure path. The Rust-owned journal and runtime
checkpoint adapter now preserve it through the separate `conductorStore.*` RPC
boundary. Sender-guarded main/preload/API wiring and the dedicated nine-locale
chat entry/history/consent components are fixture-verified. Isolated native
whole-app form, consent, mouse/Enter/Space and reload/relaunch acceptance passes;
final committed candidate and fork integration qualification remain pending.

The journal uses bounded versioned `kv` indexes and immutable content-addressed
payload files, not Node-owned SQLite or a second gate schema. Transactional
receipts provide exact-event deduplication; lease and expected-version checks
fence stale workers. Host startup interrupts active projections without changing
the saved engine checkpoint. Explicit resume validates the engine and source
before acquiring a new lease; history reads do not dispatch. Local acceptance
has exercised actual Rust RPC and motor checkpoints across an owned host restart.

Engine declarations are generated from the unchanged sources with strict
TypeScript checking. Only type-only Harness service imports are mapped to small
structural interfaces; no substitute service runtime ships. Adapter interfaces
retain `unknown` at model boundaries, and generated declarations and negative
consumer contracts are typechecked without public `any` or suppressed errors.

The specialist transport now creates a fresh existing `SubagentRun` per dispatch,
with the durable owner session's request-time auth and no generic Task registry.
It reads complete assistant `message_end` JSON, not the truncated Task report,
and journals actual usage before returning. The independent critic receives only
the exact reserved Harness prompt, without extra tools, history or instructions.
Loopback transport fixtures cover output caps, missing usage, file tools,
cancellation, invalid prose and journal failure; they prove no live model quality.

Private Conductor file calls carry the journal lease plus dispatch/worker/stage
identity through the existing `tools.execute` permission path. Host checks narrow
this to the selected repository and captured canonical baseline roots. It checks
liveness before permission evaluation, before any allow-session grant and under
the host state lock through final filesystem execution after all waits. Original
ignore, sensitive-file and hashline checks remain. No renderer/model schema exposes
the private lease. Write/Edit cancellation uses the existing `tools.abort` path;
late approval, redirected scope and stale dispatches do not authorize effects.
Edit rename/register indirection is deliberately unavailable in this first bridge.
Actual host-process fixtures cover allowed writes/edits, late allow-once and
allow-session after interruption, cancelled Edit, redirected junctions and owned
review-snapshot cleanup. Source-bound owner consent and the dedicated service now
connect through actual sidecar RPC. The sidecar bundle lazily imports a separate
service file and one external, hash-verified engine package with both MIT notices;
it does not hoist engine imports into ordinary chat startup. Isolated bundle
fixtures verify that absent/tampered engines block Conductor but ordinary local
chat still works. Parent-owned process identities and explicit reverse-RPC names
scope lease fencing to the dying sidecar, including delayed create/resume acks.
Intake Read/dispose and resume cancellation settle before later workers can start.
Actual child-loss fixtures exercise interruption, no replay on restart, cancelled
resume admission and a separate explicit resume with a fresh worker. Rust owns a
bounded persistent resource registry and creates confined containers under the
host lock before Node can start them. Fencing removes only recorded names/files;
failed or uncertain cleanup remains visible rather than granting resume. A shared
compile-time seccomp asset keeps the Rust creation and Node evidence consistent.
Real running-container fixtures verify cleanup after sidecar loss and host restart.
Host loss/replacement revokes and awaits Conductor operations without killing the
shared sidecar; old reverse calls cannot cross into the replacement host. Existing
session disposal also settles only that owner's Conductor operations. The actual
API/preload/main/provider-resolution/sidecar/Harness/Rust fixture chain passes,
as does the isolated shipped-renderer native fixture path.

Main resolves the repo from the durable owning session and rechecks it after
asynchronous preparation. A narrow extraction reuses existing provider/model
binding without shell, prompts, skills, MCP, plugins or generic Task catalogs.
Renderer input can choose only fixed quality-command IDs. The initial catalog
contains `node-tests`: a pinned cached Linux/amd64 Node image runs
`/usr/local/bin/node --test --test-isolation=none` under unchanged confinement.
Single-process test execution avoids denied process spawning; assertions are
unchanged. Unsupported local Docker/image prerequisites block implementation,
never trigger downloads. Typed history projections read only the acknowledged
journal prefix and retain distinct worker outputs, validated reports and gates.

## Alternatives

- Rebranding Tasks is rejected: it has no authoritative gates or evidence.
- Extending the existing MCP pilot is rejected: its scope and other clients are
  explicitly read-only in this task.
- A desktop-owned state machine is rejected: it could disagree with Harness.
- Importing ignored local build artifacts is rejected: exports were observed to
  differ from the pinned source. Source hashes alone cannot attest those builds.

## Consequences and acceptance

The adapter carries security obligations normally supplied by `tool-conductor`:
host-resolved baselines/catalogs, child-scoped tool restrictions, read-only
analysis, fresh quality evidence, cancellation and explicit execution approval.
These must be tested at their actual boundaries before this ADR is accepted.
No production provider credentials or live model calls are part of acceptance.
Local provider/OS fixtures do not establish live model quality. Native Electron
input and restart/no-replay have passed on the development candidate. All-locale
catalogs and component checks pass; final qualification and source delivery are
tracked in the [acceptance matrix](../project/harness-conductor-acceptance.md).
This document alone proves none of those outcomes.
