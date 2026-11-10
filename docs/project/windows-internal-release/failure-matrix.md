# Windows internal release: failure matrix

## Evidence boundary and counts

This is a sanitized qualification record, **not an all-green release claim**.
Baseline: `cf3b69b585323c3908a615cdaffadb78e319bcbc`. Candidate:
`0.15.7-super.1`. C1/C2/C3 are historical precommit runs. The private final
candidate manifest pins the subsequently committed source/base/integration tree.

| Surface | Baseline | Candidate first | Candidate second (historical; C3 below) |
| --- | --- | --- | --- |
| Desktop | 2,934 passed, 49 failed, 7 existing skips; 2,990 total | 2,962 passed, 24 failed, 7 existing skips; 2,993 total | 2,970 passed, **16 failed**, 7 existing skips; 2,993 total |
| Agent runtime | 1,025 passed, 20 failed; 1 additional suite-load failure | 1,070 passed | **1,070 passed**, 71 files |
| Host runtime | 43 passed, 1 failed, 3 existing skips | 44 passed, 3 existing skips | **44 passed**, 3 existing skips |
| pi-host | 1 passed, 5 failed | 4 passed, 2 failed | 4 passed, **2 failed** |
| Rust host-core | 659 passed, 4 failed; 663 total | 664 passed in supplied Rust candidate run | **664/664 passed**, no ignored tests |

All three recursive JavaScript candidate runs exit nonzero. The retained 18 failures
are retained POSIX/macOS qualification gates, including an explicitly unsupported
Windows password-authentication path, not converted to skips or passes. No new
skips or assertion weakening are used. Other packages in the supplied recursive
runs passed; their totals are not added to the affected-surface counts above.

Evidence keys below refer to private execution artifacts by basename only:

- **B**: `windows-baseline-js.log` / `windows-baseline-js.utf8.txt`.
- **C1**: `windows-candidate-js-first.log` / `.utf8.txt` counterpart.
- **C2**: `windows-candidate-js-second.log` / `.utf8.txt` counterpart.
- **C3**: `windows-candidate-js-third.log`: Desktop 2,972 passed / 16 failed /
  7 existing skips, 2,995 total; includes two new passing offline-mode guards.
  Runtime 1,070 passed; host-runtime 44 passed / 3 existing skips; pi-host
  4 passed / 2 failed. Same 18 retained failures as C2; no additional failed test.
  Bounded cleanup and its three owned-lock controls were verified before C3.
- **RB**, **RC**: `windows-baseline-rust.log`, `windows-candidate-rust-first.log`
  and their `.utf8.txt` counterparts.
- `windows-baseline-failures.txt` and `windows-release-stage2-handoff.md`
  cross-check the inventory; repeated end-of-run summaries are not extra failures.

Original PowerShell logs are UTF-16/BOM encoded. The supplied decoded UTF-8
copies were read with ANSI formatting disregarded; errors below omit private
absolute paths, generated identifiers, and credential values. `<temp>`,
`<project>`, and `<data-dir>` are sanitized placeholders, not literal inputs.
Intentional error output inside passing negative tests (for example fixture
collision/ENOSPC) is not counted as an additional failed test.

There are **81 unique failure records below: 80 named tests and one suite-load
failure** (50 Desktop, 20 native-runtime tests, one runtime suite, one host-runtime
test, five pi-host tests, four Rust tests). A test that fails in multiple runs
appears once, with its error progression recorded in that row.

## Reproduction commands

Run from the repository root in the dedicated candidate worktree, using the
existing compatible dependencies and builds. These are reproduction recipes,
not claims that this documentation task reran tests.

| Key | Command |
| --- | --- |
| JS | `pnpm.cmd -r --no-bail --if-present test` |
| RS | `cargo test -p host-core --locked` |
| D(file) | `pnpm.cmd -C apps/desktop exec node --test test/<file>` |
| A(file) | `pnpm.cmd -C packages/agent-runtime exec vitest run src/<file>` |
| H(file) | `pnpm.cmd -C packages/host-runtime exec vitest run src/<file>` |
| P(file) | `pnpm.cmd -C apps/pi-host exec vitest run src/<file>` |
| R(name) | `cargo test -p host-core --locked <fully-qualified-test-name> -- --exact` |

For latest Windows JavaScript reproduction, prepend the installed Git Bash
`bin` directory to **the current process's** PATH, not the machine/user PATH:

```powershell
$previousPath = $env:PATH
try {
  $env:PATH = '<Git installation>/bin;' + $previousPath
  pnpm.cmd -r --no-bail --if-present test
} finally {
  $env:PATH = $previousPath
}
```

Use that same process-local setup for D(file). The unchanged baseline lacked
`sh` on its effective PATH; merely adding a shell does not provide Windows with
POSIX executable bits, executable shebang files, or POSIX process groups.
Historical bootstrap reproduction must not reuse the old unguarded launcher;
use the current guarded fixture, with owned temporary tools only.

## Classification and shared controls

- **T-path — test portability defect, corrected:** native path/URL handling or
  expected serialization was wrong. No product permission/trust boundary changed.
- **T-isolation — test environment contamination, corrected:** native fixtures
  could discover resources above their temporary project. Current tests isolate
  HOME/USERPROFILE, enable offline mode, hide only external discovery sentinels,
  and restore the ESM filesystem binding and environment afterward. An owned
  outside canary is excluded, while untrusted project and fixture-ancestor
  resources still block prompting without appending or invoking the model.
  The actual external private marker contents were not inspected or established.
- **T-shell — shell fixture prerequisite/launcher defect, corrected:** use
  `fileURLToPath`, native PATH delimiter, and guarded same-interpreter fixture
  PATH where required. These fake Apple-tool tests do not certify real signing.
- **T-clock — wall-clock-sensitive fixture, corrected:** deterministic external
  fetch plus controlled timers preserves the distinct connection/call deadline.
- **P-fixed — confirmed existing Windows product defect, corrected:** native
  browse containment or mixed-separator fork-reference rewriting; not a waiver.
- **E-mode — POSIX filesystem prerequisite unavailable:** executable/owner-only
  permission assertions stay unchanged. An owned Windows file requested as 0600
  reports 0666 (`mode & 0o077 == 54`). This does not prove a Windows ACL guarantee;
  remote pi-host credential confidentiality is not qualified on Windows here.
- **E-spawn — POSIX executable fixture prerequisite unavailable:** an owned
  extensionless shebang fixture fails direct native spawn with ENOENT, while
  explicit Git Bash execution of the same file prints its expected marker.
  This explains fixture failure, not a successful real Windows SSH connection.
- **E-password — expected unsupported Windows behavior:** production
  `createSshAskpass` explicitly rejects Windows before creating material.
  The existing Windows-refusal test passes and asserts the temporary directory
  is empty; POSIX password-success tests are retained, not weakened.
- **E-group — macOS-only POSIX process-group prerequisite unavailable:** the
  watchdog uses `process.kill(-pid, signal)` then direct-child fallback. Parent
  qualification control reports ESRCH for a negative owned PID on Windows and
  successful direct child termination. A targeted Git Bash rerun still takes
  13,086 ms against the unchanged `< 10,000 ms` assertion. The two-second timeout
  plus kill-grace/settle path explains the approximately 13-second result. This
  is not macOS signing certification; native macOS process-tree qualification
  remains required.
- **T-cleanup — Windows transient-handle cleanup portability:** baseline cleanup
  failed with EBUSY after the shell writer. An owned child holding its cwd reproduces
  EBUSY; bounded retries still reject a persistent lock and succeed after release.
  The test now uses `rm` maxRetries=5/retryDelay=100 for cleanup only, never retries
  assertions. The historical lock holder is unknown; no antivirus/process claim is made.

The current POSIX launcher converts the owned tool directory with `cygpath`,
sets PATH inside the interpreter, verifies exact `command -v` matches, and
sources the real script in that same process. Bootstrap requires fake `curl`
and `sha256sum`. Parent's `windows-qualification-controls.log` control reports
exit 125 when required fake `curl` is absent and confirms the script marker was
never created. Earlier unguarded Git Bash execution may have reached real curl
and downloaded a non-provider release artifact before checksum rejection; **no
artifact was installed**. That earlier run is not network-free evidence and is
not used as readiness proof.

## Desktop failures: one row per test

For each subsection, the heading supplies the D(file) reproduction key. `Pass`
means observed in C2, not final-commit or PR-integration acceptance. `Fail`
remains a nonzero test result. B error details are at lines 3,782–4,651; C1
changes at 3,410–3,599; C2 retained errors at 3,410–3,665 in the UTF-8 copies.

### D(agent-runtime-bundle-package.test.mjs)

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| the chained write step produces a package.json Node will treat as ESM | B: `EBUSY: resource busy or locked, rmdir '<temp>/pi-agent-runtime-bundle-…'` | T-cleanup | C1/C2 pass; targeted 5/5 pass after bounded cleanup retry. Owned cwd-lock positive/persistent-negative/release controls pass. Historical lock holder unknown; real chained write/ESM assertion retained. |

### D(logger-routing.test.mjs)

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| logger bounds and redacts messages, paths, credentials, and arbitrary data | B: actual `<data-dir>\workspace\private.txt`, expected `<data-dir>/workspace/private.txt` | T-path | C2 pass; native `join` expectation, redaction was already effective. |

### D(macos-release-verification.test.mjs)

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| the DMG is submitted to Apple before it is stapled | B: bash cannot find malformed script URL path, exit `127 !== 0`; C1: `the submitted artifact is the DMG` assertion false | T-path / T-shell | C2 pass; decoded file path and normalized shell-path comparison. |
| stapling retries only after Apple accepts the DMG | B: bash script `No such file or directory`, `127 !== 0` | T-shell | C2 pass; fake Apple tools, bounded retry assertion retained. |
| a rejected DMG is never stapled and the Apple log is fetched | B: `127 !== 1` | T-shell | C2 pass; script-path correction restores rejection assertions. |
| a failed submission fails the run and dumps the Apple log | B: `127 !== 1` | T-shell | C2 pass; fake submission failure remains asserted. |
| the notarization step fails closed without team-scoped credentials | B: `127 !== 1` | T-shell | C2 pass; missing-credential rejection remains asserted. |
| macOS release verification requires a notarized Developer ID app and DMG | B: bash cannot find malformed script URL path, `127 !== 0`; C1: stapler paths use mixed `/` separators instead of expected `\` | T-path / T-shell | C2 pass; compare equivalent shell paths, full verification expectations retained. |
| macOS release verification rejects a Developer ID app without notarization | B: `127 !== 1` | T-shell | C2 pass; notarization rejection retained. |
| macOS release verification accepts the prefixed identity form | B: bash script `No such file or directory`, `127 !== 0` | T-shell | C2 pass; identity assertion retained. |
| macOS release verification rejects a different signing identity | B: `127 !== 1` | T-shell | C2 pass; mismatched-identity rejection retained. |

### D(macos-signing-diagnostics.test.mjs)

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| diagnostics report an available Developer ID identity | B: bash cannot find backslash-collapsed script path, `127 !== 0`; C1: `macOS signing diagnostics must run on macOS`, `1 !== 0` | T-shell | C2 pass; guarded fake `uname` and diagnostics tools resolve inside interpreter. |
| diagnostics fail closed when --require-identity finds no identity | B: `127 !== 1`; C1: expected `/not available/`, got `macOS signing diagnostics must run on macOS` | T-shell | C2 pass; fake platform/tool selection corrected, missing-identity gate retained. |
| diagnostics treat a missing identity as a warning by default | B: bash script `No such file or directory`, `127 !== 0`; C1: `macOS signing diagnostics must run on macOS`, `1 !== 0` | T-shell | C2 pass; default-warning assertion retained. |
| diagnostics refuse to run off macOS | B: `127 !== 1` | T-shell | C2 pass; non-macOS rejection still asserted. |
| diagnostics never echo signing secrets | B: bash script `No such file or directory`, `127 !== 0`; C1: `macOS signing diagnostics must run on macOS`, `1 !== 0` | T-shell | C2 pass; output secrecy assertions retained; no secret values published here. |
| inventory counts the signing payload of a release directory | B/C1/C2: expected `executables: script=1 mach-o=3`, actual `executables: script=0 mach-o=0` | E-mode | **Fail**; Mach-O identification still counts three, but NTFS does not provide the expected executable bits. Requires POSIX/macOS qualification. |

### D(macos-signing-watchdog.test.mjs)

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| forwards child output with a [sign] prefix and reports a clean exit | B: `stdout.includes("[sign] notice: nothing to see")` false | T-shell | C2 pass with process-local Git Bash; output assertion unchanged. |
| a silent signing stage produces a stall dump without failing the run | B: expected `last file: /tmp/x/Electron Framework`, actual `last file: unknown`, recent output `<none>` | T-shell | C2 pass with Git Bash; stall assertions unchanged. |
| a hard timeout kills the process group, dumps diagnostics and exits 124 | B: expected `last file: /tmp/x/Foo`, actual `unknown`; C1: `timeout took 13196ms`; C2: `timeout took 13093ms` | E-group (B also T-shell) | **Fail**; targeted rerun 13,086 ms; owned negative-PID/direct-child control supports prerequisite classification. `< 10,000 ms` remains unchanged; native macOS qualification pending. |
| redacts secrets printed by the child and by codesign-style arguments | B: expected `[sign] stderr [redacted]`, actual empty output | T-shell | C2 pass with Git Bash; redaction assertion unchanged. |
| --no-codesign-shim runs the command untouched and reports zero calls | B: `stdout.includes("PI_CODESIGN_LOG=unset")` false | T-shell | C2 pass with Git Bash; zero-call assertion unchanged. |

### D(packaging-footprint.test.mjs)

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| macOS DMG is a two-icon install; ZIP keeps the unsigned helper | B/C1/C2: `opening helper must be executable`, actual execute-bit mask `0` | E-mode | **Fail**; unchanged macOS helper-mode gate requires POSIX checkout/filesystem. Not a Windows installer result. |

### D(plugin-fs-scope.test.mjs)

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| the project's other folders are not an escape hatch | B: actual `INVALID_ARGUMENT`, expected `NOT_FOUND` | T-path | C2 pass; exact Windows `path escapes the plugin's root` error versus POSIX rewritten-relative missing path. Scope/credential/audit rejection assertions retained. |

### D(provider-endpoint-metadata.test.mjs)

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| a custom row on a published host gets that publisher's model metadata | B: `the bundled snapshot must load`, `false !== true` | T-path | C2 pass; catalog fixture uses `fileURLToPath`, no catalog/provider policy override. |
| a relay's list reads the shipped publisher's record for a known id | B: `the bundled snapshot must load`, `false !== true` | T-path | C2 pass; bundled catalog fixture loads. |
| a hand-typed id on the same relay answers with the same record | B: `the bundled snapshot must load`, `false !== true` | T-path | C2 pass; attribution assertions retained. |
| a relay's list keeps the tool support a majority of publishers states | B: `the bundled snapshot must load`, `false !== true` | T-path | C2 pass; metadata assertions retained. |
| a relay reads a shipped publisher's own record, not a reseller's | B: `the bundled snapshot must load`, `false !== true` | T-path | C2 pass; publisher-boundary assertions retained. |

### D(provider-model-list-scope.test.mjs)

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| the settings list can ask for every model a provider publishes | B: catalog `ensureLoaded()` returned false, expected true | T-path | C2 pass; decoded catalog fixture path, no model override. |
| the wider list keeps one record per id and stays attributed to the provider | B: catalog `ensureLoaded()` returned false, expected true | T-path | C2 pass; uniqueness/attribution assertions retained. |

### D(remote-host-bootstrap-script.test.mjs)

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| the generated script is valid POSIX shell, even with hostile inputs | B: `spawnSync sh ENOENT` | T-shell | C2 pass; Git Bash syntax check with hostile-input assertions retained. |
| a hostile version stays one literal value when the assignments run | B: `spawnSync sh ENOENT` | T-shell | C2 pass; literal-value assertion retained. |
| the generated script installs, starts, and prints the ready/pairing lines | B: `spawnSync sh ENOENT`; C1: `PI_HOST_BOOTSTRAP_FAILED checksum-mismatch` | T-shell | C2 pass with exact fake-tool guards; fixture-only installation/start, not a real installer run. Earlier possible real curl download is excluded as readiness evidence. |
| a checksum mismatch fails the script before anything is installed | B: expected `PI_HOST_BOOTSTRAP_FAILED checksum-mismatch`, actual `'undefined'` stderr | T-shell | C2 pass; checksum rejection/no-install assertions retained. Guard negative control exits 125 before script execution. |

### D(remote-host-ssh-password.test.mjs)

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| a password target reaches ssh through the askpass helper and nowhere else | B/C1/C2: `password authentication is not supported by OpenSSH on Windows; use an SSH key or agent` (`HOST_BOOTSTRAP_FAILED`) | E-password | **Fail**; existing Windows-refusal/no-material test passes. Password success needs POSIX qualification. |
| a key-authenticated transport is handed no askpass material | B/C1/C2: `spawn <temp>/ssh-no-askpass ENOENT` | E-spawn | **Fail**; owned shebang spawn control explains missing fixture execution, not real key-auth success. |
| each command gets its own credential, and none outlives it | B/C1/C2: `password authentication is not supported by OpenSSH on Windows; use an SSH key or agent` | E-password | **Fail**; Windows rejects before writing material; POSIX lifetime test unchanged. |
| dispose removes credential material that no child has reclaimed | B/C1/C2: `password authentication is not supported by OpenSSH on Windows; use an SSH key or agent` | E-password | **Fail**; Windows rejection control passes; POSIX cleanup test unchanged. |
| createSshAskpass writes a 0600 secret in a 0700 directory and cleans up | B/C1/C2: `password authentication is not supported by OpenSSH on Windows; use an SSH key or agent` | E-password | **Fail**; unsupported branch intentionally fails closed; POSIX mode/lifetime assertions unchanged. |

### D(remote-host-ssh-transport.test.mjs)

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| exec passes the command as one argv entry behind the common options | B/C1/C2: `spawn <temp>/ssh-argv-echo ENOENT` (`HOST_BOOTSTRAP_FAILED`) | E-spawn | **Fail**; shebang control; argv test unchanged. |
| execWithInput runs the script through `sh -s` with the body on stdin | B/C1/C2: `spawn <temp>/ssh-argv-and-stdin ENOENT` (`HOST_BOOTSTRAP_FAILED`) | E-spawn | **Fail**; fixture cannot start; stdin test unchanged. |
| a non-zero exit becomes a typed error carrying both streams | B/C1/C2: exit-code assertion `undefined !== 3` after fixture spawn failure | E-spawn | **Fail**; does not reach fake process exit/stream assertions. |
| the stdout of that error is redacted of a live pairing token | B/C1/C2: exit-code assertion `undefined !== 7` after fixture spawn failure | E-spawn | **Fail**; does not exercise fake emitted-token redaction on this host. |
| a command outliving timeoutMs is killed, not awaited | B/C1/C2: expected `/timed out after 400 ms/`, got `spawn <temp>/ssh-sleeper ENOENT` | E-spawn | **Fail**; deadline assertion unchanged; no child reached timeout path. |
| forward rejects fast, with the ssh diagnostic, when ssh exits instead | B/C1/C2: expected `/Permission denied \(publickey\)/`, got `spawn <temp>/ssh-dead ENOENT` | E-spawn | **Fail**; native fixture prerequisite absent. |
| forward resolves once the port answers and close() is idempotent | B/C1/C2: `spawn <temp>/ssh-forward ENOENT` (`REMOTE_FORWARD_FAILED`) | E-spawn | **Fail**; forwarding/cleanup qualification still needs executable fixture environment. |
| dispose reaps a live forward and leaves a finished exec alone | B/C1/C2: `spawn <temp>/ssh-dispose ENOENT` (`HOST_BOOTSTRAP_FAILED`) | E-spawn | **Fail**; lifetime assertions unchanged, fixture never starts. |

### D(settings-import-page.test.mjs)

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| import is one workbench per kind instead of four stacked scan cards | B: input unexpectedly matched `/<SettingsCard/` | T-path | C2 pass; domain-source module markers normalized to `/`, so extraction ends at the intended next module instead of including unrelated settings sections. |

### D(plugin-mcp.test.mjs) — candidate-first-only failure

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| a remote MCP tool can run longer than the connection timeout | C1: `mcp initialize timed out after 20ms` (`TIMEOUT`) | T-clock | C2 pass; actual connect completes, external fetch response is held, controlled timer advances 21 ms against connect=20/call=500 ms, then response resolves. No product MCP timeout change or relaxed assertion. |

## Agent runtime

B UTF-8 lines 352–615 contain one suite-load failure and the 20 failures below.
C2 lines 317–318 report all 71 files / 1,070 tests passing. Each native test
below reproduces with **A(native-pi-session.test.ts)**; suite prefixes are
included to disambiguate full names. The shared T-isolation control applies to
all trust-related rows; it does not authorize trusting real external resources.

| Test or suite name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| `hosted-search-compaction.test.ts` — suite load; A(hosted-search-compaction.test.ts) | B: `cannot locate the dist root of @earendil-works/pi-coding-agent` | T-path | C2 pass; marker now uses native `sep` after `fileURLToPath`, instead of literal `/dist/`. |
| NativePiSessionService > continues through AgentSession and appends the faux-model turn to the original file | B: `Native Pi project resources are not trusted` | T-isolation | C2 pass; isolated fixture and trust-negative controls. |
| native continuation review regressions > uses the real offline credential/catalog and reports missing exact auth/model | B: `expected false to be true` for `canPrompt` | T-isolation | C2 pass; offline fixture remains real, no real credential/provider use. |
| native continuation review regressions > settles retries once, rejects overlap without disposal, acknowledges distinct durable users, and keeps own idle lease usable | B: `Native Pi project resources are not trusted` | T-isolation | C2 pass; lease/retry assertions retained. |
| native continuation review regressions > makes reclaimable dead-owner leases reachable via list/detail without stealing live leases | B: `expected false to be true` for `canPrompt` | T-isolation | C2 pass; ownership assertions retained. |
| native continuation review regressions > binds native startup/resources once before prompting with guarded original-file appends | B: `Native Pi project resources are not trusted` | T-isolation | C2 pass; startup/persistence assertions retained. |
| native continuation review regressions > disposes session and releases ownership on bind failure so opening can be retried | B: expected `binding failed`, received `Native Pi project resources are not trusted` | T-isolation | C2 pass; bind-failure cleanup assertions retained. |
| native continuation review regressions > aborts after persistence without removing or replacing the native user row | B: `Native Pi project resources are not trusted` | T-isolation | C2 pass; cancellation/persistence assertions retained. |
| native fork children > forks the current branch into one durable child without touching the parent | B: `expected false to be true` for child `canPrompt` | T-isolation | C2 pass; parent/child persistence assertions retained. |
| native fork children > appends a reopened first-user child without rewriting either file | B: `Native Pi project resources are not trusted` | T-isolation | C2 pass; append-only assertions retained. |
| native fork children > leaves the catalog unchanged for wrong-branch, read-only and busy forks | B: `Native Pi project resources are not trusted` | T-isolation | C2 pass; rejection/catalog assertions retained. |
| native fork children > emits a provisional stream row replaced by the durable entry id | B: `Native Pi project resources are not trusted` | T-isolation | C2 pass; provisional/durable transition assertions retained. |
| native fork children > refuses a live foreign lease and reclaims only a dead-owner lease | B: actual `project-untrusted`, expected `busy` | T-isolation | C2 pass; foreign-lease rejection remains tested. |
| native fork children > refuses a changed owned runtime but still forks a provider-unavailable parent as data | B: `Native Pi project resources are not trusted` | T-isolation | C2 pass; capability/recovery assertions retained. |
| native fork children > never deletes a foreign publication and classifies the failure path-free | B: expected directory entry `<temp>/…/<generated-file>.jsonl`, actual basename `<generated-file>.jsonl` | T-path | C2 pass; native `basename` expectation, foreign-publication byte-preservation assertions retained. |
| independent native ownership, identity and tool regressions > keeps an owned settled lease promptable across refreshes | B: `Native Pi project resources are not trusted` | T-isolation | C2 pass; owned lease remains tested. |
| independent native ownership, identity and tool regressions > acknowledges persisted native user IDs before terminal completion without storing caller IDs | B: `Native Pi project resources are not trusted` | T-isolation | C2 pass; durable ID/terminal ordering assertions retained. |
| independent native ownership, identity and tool regressions > sends zero native tools to the model | B: `Native Pi project resources are not trusted` | T-isolation | C2 pass; zero-tool assertion retained. |
| independent native ownership, identity and tool regressions > cleans up a real failing startup hook and permits a repaired extension to bind | B: expected `fixture startup failure`, received `Native Pi project resources are not trusted` | T-isolation | C2 pass; extension startup/repair cleanup assertions retained. |
| native settlement and reclaim boundaries > publishes terminal completion only after delayed settled hooks append | B: `Native Pi project resources are not trusted` | T-isolation | C2 pass; settlement ordering assertion retained. |
| native settlement and reclaim boundaries > permits only complete same-file append extensions for dead-local capability recovery | B: actual `project-untrusted`, expected `busy` | T-isolation | C2 pass; same-file recovery bounds retained. |

## Host runtime

Reproduction: **H(launch-resolver.test.ts)**. B lines 647–663; C2 lines 341–342.

| Test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| createHeadlessLaunchResolver > resolves the session's provider, its secret, the shell, skills and project memory | B: actual `\data\scratch\s1`, expected `/data/scratch/s1` (synthetic fixture values) | T-path | C2 pass; native `join` expected scratch path, resolver behavior unchanged. |

## pi-host

B lines 727–808; C2 lines 406–435. File reproduction keys are included per row.
The two remaining credential-mode failures are **not** proof of secure Windows
credential ACLs; that surface is explicitly unqualified by these runs.

| Test name / reproduction | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| config > parses flags with and without values and validates the port; P(config.test.ts) | B: actual drive-rooted `C:\data`, expected `/data` (also native resolved executable/sidecar paths) | T-path | C2 pass; `resolve()` expected paths; port validation unchanged. |
| identity and credentials > mints the host id once and keeps it across restarts; P(config.test.ts) | B/C1/C2: `expected 54 to be +0` for `mode & 0o077` | E-mode | **Fail**; owned chmod/stat control reproduces NTFS behavior; no ACL implementation or confidentiality claim. |
| identity and credentials > stores devices and pairings hashed, owner-readable, and survives a reload; P(config.test.ts) | B/C1/C2: `expected 54 to be +0` for `mode & 0o077` | E-mode | **Fail**; unchanged POSIX owner-only assertion; requires POSIX host qualification. |
| pi-host operations over host-core > maps sessions, creates under a project id, and refuses configuration while busy; P(host-operations.test.ts) | B: actual workspace label `<fixture-basename>`, expected whole `<temp>/<fixture-basename>` | T-path | C2 pass; native `basename` expectation; busy/configuration assertions retained. |
| pi-host operations over host-core > registers only existing directories and browses inside the root only; P(host-operations.test.ts) | B: `RacpError: path is outside the browsable root` for legitimate child (`REMOTE_PATH_FORBIDDEN`) | P-fixed | C2 pass; native `sep` containment fix; added sibling-prefix and parent-escape rejection checks. |

## Rust host-core

Each row reproduces with **R(the full name in the first column)**. RB lines
863–890; RC line 862 records 664 passed with zero failures/ignored tests.

| Fully qualified test name | Actual sanitized error | Classification | Current outcome/control |
| --- | --- | --- | --- |
| `mcp_servers::tests::a_global_server_moves_into_a_project_with_its_state` | RB: equality mismatch, actual `Some("<project/forward-slashes>")`, expected native backslashes | T-path | RC pass; expected normalized project-path serialization; move/state/file assertions retained. |
| `sessions::fork_files::tests::copies_structured_and_compacted_inputs_and_rolls_back_until_committed` | RB: actual attachment ref still `<temp>/scratch/source/pasted\input.txt`, expected `<temp>/scratch/child/pasted/input.txt` | P-fixed | RC pass; Windows mixed-separator matching now rewrites owned references; copy/rollback assertions plus native/forward/mixed-separator regression retained. |
| `sessions::tests::fork_preserves_referenced_pasted_files_independently` | RB: actual child reference ends `pasted\first note.txt`, expected `pasted/first note.txt` | T-path (shared P-fixed matcher also exercised) | RC pass; native path construction in expected reference; independent copied bytes, source deletion, and grandchild checks retained. |
| `user_skills::tests::a_global_skill_moves_into_a_project` | RB: equality mismatch, actual `Some("<project/forward-slashes>")`, expected native backslashes | T-path | RC pass; normalized serialized expectation; source-removal/destination-content checks retained. |

## Source grounding and remaining acceptance work

Current candidate source/test locations supporting the classifications:

- `apps/desktop/test/helpers/posix-fixture.mjs:4–14` and
  `apps/desktop/test/remote-host-bootstrap-script.test.mjs:147–153`: exact fake
  tool resolution and same-interpreter execution.
- `apps/desktop/test/macos-release-verification.test.mjs:87–119`: decoded script
  path, PATH delimiter, and equivalent shell-path assertions.
- `apps/desktop/test/plugin-mcp.test.mjs:368–401`: deterministic delayed call,
  unchanged 20 ms connection / 500 ms call separation.
- `apps/desktop/test/plugin-fs-scope.test.mjs:580–608`: exact platform-specific
  rejection plus unchanged permission/credential/audit checks.
- `apps/desktop/test/helpers/domain-source.mjs:22–31,45–50` and
  `apps/desktop/test/settings-import-page.test.mjs:19–22,30–46`: module boundary
  markers and retained workbench assertions.
- `apps/desktop/test/provider-endpoint-metadata.test.mjs:17–38` and
  `apps/desktop/test/provider-model-list-scope.test.mjs:13–25`: catalog fixture
  `fileURLToPath` and actual `ensureLoaded` assertion, no model overrides.
- `packages/agent-runtime/src/hosted-search-compaction.test.ts:59–71` and
  `packages/agent-runtime/src/native-pi-session.test.ts:23–53,83–129`: native
  dist-root lookup, fixture isolation, outside-canary and untrusted-resource
  negative controls.
- `packages/host-runtime/src/launch-resolver.test.ts:59–72` and
  `apps/desktop/test/logger-routing.test.mjs:164–180`: native expected paths.
- `apps/pi-host/src/host-operations.ts:191–206` and
  `apps/pi-host/src/host-operations.test.ts:74–96`: legitimate native child
  containment and sibling/parent rejection. `apps/pi-host/src/config.test.ts:32–52`
  preserves the two failing owner-only mode assertions.
- `crates/host-core/src/sessions/fork_files.rs:48–78,224–277`:
  Windows separator-aware matching and original/new copy tests.
  `crates/host-core/src/sessions.rs:5446–5477`,
  `crates/host-core/src/mcp_servers/tests.rs:166–175`, and
  `crates/host-core/src/user_skills/tests.rs:237–249` retain native/reference
  and serialized-path expectations.
- `apps/desktop/electron/main/remote/ssh-askpass.ts:94–115` and
  `apps/desktop/test/remote-host-ssh-password.test.mjs:253–280`: unsupported
  Windows behavior and passing no-material negative control; no bypass added.
  `apps/desktop/test/remote-host-ssh-transport.test.mjs:30–75` supplies the
  non-native shebang fixtures.
- `scripts/macos-signing-watchdog.mjs:640–652,790–815` and
  `apps/desktop/test/macos-signing-watchdog.test.mjs:151–174`: negative-PID
  termination/fallback and unchanged deadline assertion.
- `apps/desktop/test/agent-runtime-bundle-package.test.mjs:86–108`: real chained
  write, unchanged ESM assertion and bounded cleanup retry. Private
  `windows-cwd-lock-control2.log` records three passing owned-lock controls.

Final tested commit/base and matching integration results belong in the private
candidate manifest. POSIX/macOS controls must run on their supported platform
before claiming those surfaces qualified; Windows mode controls are not ACL
validation and fixture spawn controls are not real remote SSH acceptance.

Six provisional unpacked-package smoke controls passed. Final-commit package
and native results are recorded separately in the private candidate manifest.
**No installer has been executed.** Real guest install/upgrade/uninstall
acceptance remains blocked pending an existing lawful Windows image; a host
installation is not a fallback. This matrix neither accepts installer behavior
nor certifies macOS signing or a public release.

## Packaged/native harness investigation after candidate preparation

The first fully HOME-isolated Conductor rerun failed waiting for four cards
while its local child Reads had completed. It inherited `PI_DESKTOP_CAPTURE=1`:
`bootstrap/window.ts` starts a separate UI capture/navigation flow with that
flag. The owned log recorded `COMPOSER_PROBE` and a failed capture-output write.
Removing that startup flag made the same isolated Conductor and Mini fixtures
pass without changing assertions. The packaged harness now sets it **only at
quit**, using the existing application-confirmation test mode, never during
startup. This is a corrected test-orchestration defect, not an unexplained
product waiver. The initial PowerShell HOME-variable assignment error and
superseded attempts remain in private logs; they are not final acceptance.
