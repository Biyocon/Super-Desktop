# Harness Conductor acceptance

## Qualification boundary

This is local-fixture evidence, not live-model acceptance. The unchanged MIT
Harness engine is revision `879ab27bdd22203675d6f0cc678652779fc089cd`, package
`0.1.0-rc.7`, record format 5. The fork base is
`5899fe3dee7d59a52de8a2223cf444b68ff6109c` (tree
`aab5aa13aa133ceca33fbcb8fa0e914b7d707c64`). Final committed-candidate and actual
PR integration qualification remain pending; development results below do not
substitute for those receipts.

All tests use owned profiles, repositories, credentials, ports and processes.
Provider fixtures are loopback SSE; Docker uses a previously cached image digest,
never a pull. No running user conversation is used or rewritten. No live provider,
paid model, microphone, speech/image generation, installer, release or VM acceptance
is claimed. The existing external MCP pilot and its source remain unchanged.

## Coverage matrix

Paths below are relative to the repository. Unit tests supplement, rather than
replace, the actual API/native chain. Native happy paths do not claim native
execution of every negative backend scenario.

| Contract | Observed proof | Coverage boundary |
| --- | --- | --- |
| 1. One engine and explicit entry | `scripts/e2e-harness-conductor.mjs` starts analysis and implementation from actual shipped form input, through preload/main/provider resolution/sidecar/Harness/Rust and back to chat. `desktop-api.acceptance.mjs` exercises the same internal chain with only the Electron IPC boundary fixture. Package/loader tests check pin, license, hashes and strict declarations. | Missing/tampered engine is exercised by actual bundle/API accepts; visible blocking/no fallback by `conductor-ui.test.mjs`. No live-model quality claim. |
| 2. Correct identities | Native acceptance verifies all eight contractual titles and existing portrait hashes, Emperor=user, no invented Ralph, four actual analysis and seven implementation workers. `agent-avatar.test.mjs`, `conductor-cards.test.mjs` and topology/transcript/budget tests cover builtins, unknown/prototype names, repeated and resumed Tasks. | Portraits do not confer authority; optional Ralph is shown only if actually dispatched. |
| 3. Actual A–G and rework | Native/API implementation performs a harmless write and actual separate D/E Node assertions; analysis explicitly skips B/D/F. Motor `engine.test.mjs`, `analysis.test.mjs`, `rework.test.mjs` execute unchanged `drive()`, including plan/design versus implementation repair and fresh authorization after plan invalidation. | NO-GO in pinned format 5 is the actual Gate-G escalation record, not an invented missing `run.decision`. Projection tests reject worker-prose imitations. |
| 4. Mandate and rights | Native Gate-C approval is separate from existing Rust Write allow-once; the file remains unchanged until the latter. Actual `host-tools.acceptance.mjs`, source/lease Rust tests, mandate/quality/dispatcher/consent/provider tests enforce scope, source and evidence lineage. | GO grants no commit, push, merge, deployment or publishing permission. Quality catalog is fixed and narrow, not arbitrary shell support. |
| 5. Actual accessible chat | Native mouse/Enter/Space opens matching workers, gates and reports; exact consent, source hashes, authority and outcomes are visible. UI/controller/projection tests cover rework, skips, NO-GO, repeated workers and stale responses. All nine catalogs have complete matching keys/placeholders. | Native UI is exercised in English; catalog checks do not certify native-language editorial quality. No color-only status. |
| 6. Persistence and lifecycle | Native renderer reload/full owned-app relaunch preserves deep-equal history, zero additional provider/dispatch/write replay and unchanged file identity/timestamps/hash. Actual host-store, lifecycle and resource-loss accepts exercise cancellation, crashes, replacement, explicit validated resume and cleanup. | History is observational. Source-effect acknowledgement failure is not rollback; cleanup failures remain visible and block resume. |
| 7. Representative local acceptance | Actual API/native analysis plus real implementation/verification, unchanged-driver negatives and real Rust/Docker lifecycle tests are mapped below. Screenshots are hashed. | Native crash/rework/missing-engine UI negatives are not claimed; lower actual boundary tests and UI components cover those behaviors. macOS native quit and live-model accept are not run. |
| 8. Checks and controlled delivery | Full JS regression, Rust checks and builds have run; results below. ADR, EN/Chinese specs, README, unreleased changelog and feature status describe actual behavior. | Final static rechecks, reviewed commits, exact committed candidate, PR integration tree, green fork gates, normal merge and clean main fast-forward remain pending. |

### Negative controls

All motor files are under `packages/conductor-runtime/test/`; runtime files are
under `packages/agent-runtime/src/conductor/`; UI tests under `apps/desktop/test/`.

| Scenario | Executed test boundary |
| --- | --- |
| Phase hop, wrong-run reports, absent evidence, malformed GO | `engine.test.mjs`: next stage never dispatches, no invented pass |
| Stale critic candidate, missing usage, excessive exact prompt/budget | `analysis.test.mjs`, `provider.test.ts` |
| Missing/stale baseline approval, wrong request/source, duplicate concurrent answer | `engine.test.mjs`, `consent.test.ts`, actual `desktop-api.acceptance.mjs` |
| Analysis writes, traversal, Git metadata, aliases/rename/register, unauthorized quality command | `mandate.test.mjs`, `dispatcher.test.mjs`, `quality.test.mjs`, `tools`/admission tests and actual host-tools accept |
| Late tool permission/allow-session, interrupted lease, retargeted directory | Actual `host-tools.acceptance.mjs` and Rust source/tool-access tests |
| Plan defect versus implementation defect, invalidation and fresh C consent | Actual unchanged-driver `rework.test.mjs` |
| Valid NO-GO versus worker prose or unrelated escalation | `rework.test.mjs`, `projection.test.ts`, `conductor-ui.test.mjs` |
| Missing/tampered engine, ordinary chat preserved | Actual `bundle.acceptance.mjs`, `desktop-api.acceptance.mjs`, loader and UI tests |
| Cancellation, ignored abort, in-flight admission/resume, owner disposal | Dispatcher/admission tests and actual service/lifecycle accepts |
| Duplicate/delayed/stale event/selection, uncertain acknowledgement | Rust CAS/dedup tests; journal/projection/history-controller tests |
| Sidecar/host loss, running container cleanup, explicit no-replay resume | Actual `service.acceptance.mjs --resource-loss`, `lifecycle.acceptance.mjs` |
| Output hardlink redirection | Actual `bundle-output.acceptance.mjs`, separate canary unchanged |

## Broad development regression

Latest full JS run: `pnpm -r --no-bail --if-present test`, Node 24.13.0/pnpm
10.34.5 on Windows. All packages ran despite platform failures. The local launcher
used isolated HOME/data, no inherited provider credentials, refusal proxies and a
Node socket/DNS/fetch guard allowing only loopback/local IPC. This is not an OS
firewall claim. Existing fake Apple/SSH tools are fixtures, not real signing or SSH
certification.

| Package | Passed | Failed | Existing skips |
| --- | --- | --- | --- |
| Desktop | 3012 | 16 | 7 |
| Agent runtime | 1106 | 0 | 0 |
| Shared | 1124 | 0 | 0 |
| Host runtime | 51 | 0 | 3 |
| Conductor motor/adapter | 31 | 0 | 0 |
| i18n | 27 | 0 | 0 |
| Agent host | 47 | 0 | 0 |
| Plugin SDK | 328 | 0 | 0 |
| Plugin devkit | 49 | 0 | 0 |
| RACP | 21 | 0 | 0 |
| Voice runtime | 39 | 0 | 0 |
| pi-host | 4 | 2 | 0 |
| Docs tests | 11 | 0 | 0 |

The 18 failures reproduce the same retained Windows limitations documented in
[the earlier failure matrix](windows-internal-release/failure-matrix.md): three
Desktop macOS executable-bit/process-group gates, thirteen POSIX SSH/askpass
fixture tests, and two pi-host owner-only mode assertions. Watchdog measured
13,186 ms against the unchanged `< 10,000 ms` requirement; inventory reports zero
executable bits, direct extensionless SSH fixtures fail `ENOENT`, Windows askpass
explicitly refuses, and pi-host mode remains 0666 rather than 0600. Those source
and test files are unchanged by this integration. No assertion was relaxed and
no new skip introduced. Local Windows full JS remains nonzero, not all-green.

Rust: `cargo fmt --check`, `cargo test -p host-core --locked --offline`,
`cargo clippy -p host-core --all-targets --offline`, and locked offline host build
all returned zero; 685 tests passed, none failed/ignored. Four pre-existing
compiler/clippy warnings remain. An owned curl wrapper in the binary directories
rejected 45 external attempts in the first broad run before execution; actual
loopback fixtures remained available. This does not qualify the old installer.

A final diff review found ordinary Read calls registered cancellation but omitted
Read from common cleanup. The actual RPC regression failed on the retained
registration; including Read in the same cleanup made the full 685-test suite
pass, covering successful, missing-file and repeated-ID reads.

All workspace typechecks, lint, docs checks (536 pages / 84 EN–Chinese spec pairs),
agent-policy synchronization, preview-version check (`check-release-docs.mjs
0.15.7` for unchanged `0.15.7-super.1`), base check and diff check passed. The one
independent read-only review found no concrete defect in its bounded security/
lifecycle scope; it did not rerun tests or certify the full product. No second
review pass or external-action authority is inferred.

A preliminary launcher accidentally selected global pnpm 12, which interpreted
the invocation as dependency setup and downloaded 60 packages before refusing an
unapproved build. This deviation is not network-free evidence. The one generated
workspace setting was removed, task dependency directories were quarantined in
scratch, and the original cache/link setup restored. Primary tracked sources
remained clean. Subsequent full build and full JS run above use pnpm 10.34.5 and
the restored shared immutable dependencies. Initial duplicate-SDK-class and
network-guard interference failures disappeared without SDK/product/test
weakening. One obsolete transcript source assertion was replaced with the new
contract: actual generic Tasks only, no fabricated Conductor specialist roster.

## Historical development native receipt

The passing development receipt has `fixtureOnly=true`, `nativeElectronAccepted=true`,
`liveModelAccepted=false`, `passed=true`, no concurrent candidate edits and no faults.
It records 16 loopback provider requests, one separate Write allow-once, 41 native
disclosure interactions, ten screenshots and eight owned children observed exited
or absent. Its base/head was the base above with uncommitted task changes; source
map digest `eae0577786861f2c9ab6347a999c753cd95aa69c7bd2e1b1bd9d0fc4ea752370`.
This is not the final committed-candidate receipt. Raw screenshots include owned
machine-local fixture paths and remain private; these original byte hashes are
published without copying private paths or images.

| Screenshot | SHA-256 |
| --- | --- |
| analysis-entry.png | `9e06fddd859b61d2c59c4bf4e26a623dc471886ee856942a60c901a1f9cc12ea` |
| analysis-completed.png | `3ead69443f790e6bc840e900ce4afb0ccf3fc765a1ffef4239bc6ef0e35e87c1` |
| implementation-entry.png | `ad3a53c685830af47f2faae9dc46e993df420d27a309d3927b299afbe40ead42` |
| implementation-exact-gate-c.png | `c9229d00aa4166b2d819dcbc25ba0e285be795e689e70198046be4eb3367a6cb` |
| separate-write-permission.png | `5b4ee56fb2a08eb974d7168a90f1d266360658a717b1ad824129007011894962` |
| implementation-completed.png | `0f56e609fe46d5fea104f8246d016a8b1ba2d51937fc152d769bbff4464c3abb` |
| reload/relaunch analysis (each) | `33927155f0fa1ec43a17049469e30a88ceff21f3db4cb87b8b1681f0cc3e2160` |
| reload/relaunch implementation (each) | `3e507735f30a776b3300f527c8672b8e5dc053454e81a53cbddc0d10bed29e27` |

Screenshots were produced with semantic/native hit-target assertions and byte
hashes; this receipt does not claim a separate visual image-review pass.

## Reproduction

Build with `pnpm build:js`, then `pnpm --filter @pi-desktop/agent-runtime bundle`
and `pnpm --filter @pi-desktop/desktop build`. Do not rebuild/edit during native
fingerprinting. Run from the task candidate, supplying explicit owned binary,
cached Docker executable/image and scratch arguments as required by each script:

- `node scripts/e2e-harness-conductor.mjs <host> <docker> <image-digest> <scratch>`
- `node packages/conductor-runtime/test/desktop-api.acceptance.mjs <host> <docker> <image-digest> <scratch>`
- `node packages/conductor-runtime/test/{host-store,host-tools,bundle,lifecycle}.acceptance.mjs <host> <scratch>` (run each named file separately)
- `node packages/conductor-runtime/test/service.acceptance.mjs <host> <docker> <image-digest> <scratch>`; repeat with `--sidecar` and `--resource-loss`.
- `node packages/conductor-runtime/test/quality-container.acceptance.mjs <docker> <image-digest> <scratch>`
- `node packages/conductor-runtime/test/bundle-output.acceptance.mjs <scratch>` (serial with bundling)

The scripts retain assertions and write task-owned result receipts. Final
candidate/integration identities, result hashes and fork delivery receipts must
be added after those actions actually occur.
