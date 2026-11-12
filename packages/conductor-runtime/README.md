# Conductor runtime adapter

Internal integration package. Chat UI, native input and complete product acceptance are still pending.

## Authority and provenance

`./engine` is built from unchanged, MIT-licensed Harness Conductor sources at
`879ab27bdd22203675d6f0cc678652779fc089cd`, package `0.1.0-rc.7`, record format 5.
The engine owns admission, gate decisions, rework and final outcomes. `./adapter`
imports that same built engine; it does not embed another gate implementation.
The build verifies the exact source manifest and emits artifact hashes plus the
Harness and bundled Zod MIT notices. No private checkout is read by normal builds.

`src/dispatcher.mjs` requires acknowledged host journaling before dispatch,
child-scoped capability guards, cancellation and independently identified workers.
`src/mandate.mjs` freezes host-selected scope and quality bindings, rejects analysis
mutation and detects changed canonical path targets. These checks narrow, never
replace, existing host permissions and ignore rules. A Rust-owned persistent
journal, typed runtime storage adapter, fresh specialist provider transport and
permission-preserving file bridge are implemented and locally tested. Dedicated
sidecar RPC, separately bundled optional service and guarded main/preload/API now
connect them. Visible chat/UI and complete product acceptance remain pending.

## Quality execution

The host catalog accepts immutable, digest-pinned Linux image definitions, explicit
argv, required D/E gates, deadlines and bounded output. The runner uses only the
local Docker engine, an empty task-owned Docker configuration and `--pull never`.
It never falls back to the host shell. A compatible cached Node Linux image is
required; this package does not install Docker or download images.

Each execution first probes the identical confinement policy against an owned
read-only mount. The repository is then mounted read-only with no network,
no capabilities, no-new-privileges, a default-deny syscall filter and bounded
CPU/memory/process count. Temporary writes are confined to a disposable tmpfs.
Network and Unix sockets are denied. Quality commands cannot write the repository;
implementation writes must go through the separately approved host tool boundary.

Production resources are durably registered in Rust before Docker effects. Rust
allocates the names and directories and creates containers under its host lock;
Node only starts the already-created containers. A delayed start cannot recreate
a container removed by fencing. Sidecar loss and host startup remove only recorded
names and recognized own files. Failed cleanup stays observable and blocks resume;
uncertain creation is never reported clean merely because the name is absent.

Only observed process exit/output becomes fresh quality evidence. Names are
unpredictable and cleanup removes only those owned containers. Failure, timeout
and cancellation never imply a gate pass.

### Unjudged evidence in record format 5

The pinned driver's `SpecialistExecutionFailure` path can checkpoint completed
quality records before a gate has judged that attempt. Its strict parser rejects
such a checkpoint with `cycle has no documented gate attempt`. The adapter does
not change Harness or synthesize a gate to work around this. On infrastructure
failure it retains the last valid engine checkpoint and keeps unjudged process
records in the acknowledged host dispatch journal. Such records are diagnostic
history only; a subsequent worker must execute fresh required commands.

## Host journal and types

`agent-runtime/src/conductor/store.ts` serializes host acknowledgements and parses
every saved/loaded engine checkpoint. Rust stores bounded indexes and deduplication
receipts in versioned `kv` namespaces, with immutable hashed payload files. Startup
revokes active leases and projects interruption without rewriting motor decisions.
Reading history never starts work. Explicit resume requires engine validation and
host-owned current-source validation before compare-and-swap lease acquisition.
The exact engine JSON string is retained to preserve candidate hash field order.
Actual source fingerprints and own-write effect chains survive restart. Explicit
Gate-C consent binds owner/run/request, source and the exact baseline/effects;
existing tool permissions remain separate. Session deletion and startup sweep
clean only recognized owned files, rejecting redirected stores.

`build-types.mjs` emits declarations directly from the pinned sources under strict
TypeScript checking. Type-only Harness service imports are mapped to minimal
structural interfaces, not runtime shims. The generated declarations, adapter
interfaces and negative consumer contracts pass strict typecheck without public
`any`, skipped library checking or type-error suppression. All emitted type files
are covered by the build provenance hashes.

## Local verification

From this package:

```text
node build.mjs
node typecheck.mjs
node --test test/*.test.mjs
node test/quality-container.acceptance.mjs <absolute-docker-executable> <cached-sha256-image-id> <owned-scratch-root>
node test/host-store.acceptance.mjs <absolute-task-built-host-binary> <owned-scratch-root>
node test/host-tools.acceptance.mjs <absolute-task-built-host-binary> <owned-scratch-root>
node test/service.acceptance.mjs <absolute-task-built-host-binary> <absolute-docker-executable> <cached-sha256-image-id> <owned-scratch-root>
node test/service.acceptance.mjs <absolute-task-built-host-binary> <absolute-docker-executable> <cached-sha256-image-id> <owned-scratch-root> --sidecar
node test/service.acceptance.mjs <absolute-task-built-host-binary> <absolute-docker-executable> <cached-sha256-image-id> <owned-scratch-root> --resource-loss
node test/bundle-output.acceptance.mjs <owned-scratch-root>
node test/bundle.acceptance.mjs <absolute-task-built-host-binary> <owned-scratch-root>
node test/lifecycle.acceptance.mjs <absolute-task-built-host-binary> <owned-scratch-root>
node test/desktop-api.acceptance.mjs <absolute-task-built-host-binary> <absolute-docker-executable> <cached-sha256-image-id> <owned-scratch-root>
```

The container acceptance runs actual A–G, changes one owned harmless file and
verifies it in independent real D/E processes. It also exercises process failure,
output truncation/hash, timeout, owned-container removal and a specialist failure
after successful quality execution. Model outputs are fixtures. This is not
live-model, full desktop-chain, persistence/restart or native Electron acceptance.

The separate host-store acceptance runs the actual runtime journal, Rust RPC and
Harness checkpoints across an owned host restart: no dispatch on load, stale lease
rejection, explicit resume from B after preserved A, distinct workers and unchanged
fixture file. Its provider reports are motor-contract fixtures with no real change
or quality execution. It is not a substitute for the container or full desktop
acceptance, and no live-model quality is claimed.

The host-tools acceptance uses actual Harness dispatch, runtime lease binding,
Rust permission dialogs and existing file executors. It covers allowed Write/Edit,
late allow-once/allow-session after interruption, cancelled Edit and intake Read,
redirected scope junctions and cleanup. It stops before Gate D: provider reports and Gate-C consent
are explicitly fixtures, and successful tools are never reported as complete
implementation or native desktop acceptance. Separate loopback provider tests use
the actual `SubagentRun` transport, complete JSON and measured usage without live calls.

The service acceptance combines actual admission, complete specialist transport,
the unchanged driver, explicit consent API, Rust tools and independent confined
D/E processes. It proves read-only analysis and a harmless implementation change,
durable parseable history and no provider replay on history reads. Only provider
responses and owner/permission UI answers are fixtures. The optional loader checks
the shipped engine/adapter/license hashes before importing execution code.

The `--sidecar` variant uses the production parent `AgentSidecar`/`HostProcess`,
dedicated `conductor.*` RPCs and the actual packaged child. It repeats analysis
and implementation, cancels immediate admission, kills/recreates the sidecar and
checks identical completed history without provider replay. The bundle acceptance
copies the actual shipped runtime into isolated scratch directories: missing and
tampered engines block Conductor before execution while ordinary loopback chat
still completes. The lifecycle acceptance kills a child during a held provider
request, observes Rust lease fencing, loads without replay, cancels resume admission
and separately resumes with a fresh worker before cancelling the active call.

Each sidecar receives a parent-owned process identity. Reverse host RPC is explicitly
allowlisted; a sidecar cannot interrupt arbitrary runtime identities. Parent loss
handling waits for in-flight lease acquisition and fences again afterward. Intake
Read and resume admission are cancellable and dispose awaits their settlement.
Parked owner-waiting runs can be interrupted without changing their engine record.
The resource-loss fixture observes a real running quality container before killing
its sidecar or host, verifies exact-name removal and own-directory cleanup, and
reopens unchanged A-C history without replay. The lifecycle fixture also checks
automatic provider abort on host loss, live host replacement and owner disposal;
only explicit resume against the replacement host launches a new worker.
The separate desktop-api acceptance additionally covers actual renderer API,
preload, sender-guarded main and existing provider resolution through the packaged
sidecar/Harness/Rust chain. Electron IPC, loopback provider/metadata and owner/UI
answers are fixtures, not native input or live-model quality. It verifies read-only
analysis, a real harmless implementation, independent D/E `node-tests`, exact
owner consent plus separate allow-once file permission, no-replay restart history,
sender/input negatives and missing engine in a task-owned bundle copy.

Main selects the session-owned repo and a fixed digest-pinned Linux/amd64 Node
catalog. `/usr/local/bin/node --test --test-isolation=none` runs existing assertions
in one process because process spawning is denied by the unchanged seccomp policy.
Only already-cached images at the fixed local Docker endpoint are inspected;
there is no installation/download or arbitrary renderer argv. Analysis needs no
Docker execution. Actual chat UI/native input and live model quality remain open.
