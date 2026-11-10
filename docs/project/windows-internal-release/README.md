# Internal Windows candidate 0.15.7-super.1

**Publication: awaiting user acceptance. Installer acceptance: blocked.**
This is source and local unsigned x64 NSIS preparation, not a public release.
No version tag, binary asset or updaterfeed is published. Do not run the
installer/uninstaller on the working host.

## Changes and contracts

- Permanent Windows identity `io.github.biyocon.super-desktop`, executable,
  shortcuts and independent installed/development data. No automatic migration;
  existing PI-Desktop and fork development profiles remain untouched.
- Windows mixed-separator fork-file reference rewriting and browse-root
  containment fixed with regressions. Portable test fixtures preserve plugin
  root guards, secret redaction and untrusted-resource refusal.
- Prior fork functionality includes safe agent-library import, builtin-aware
  16-user budget, truthful Conductor task lifecycle, Hassan/None pet gallery,
  reviewed imports and draft-only Mini dictation.
- See [identity ADR](../../adr/windows-super-desktop-identity.md),
  [release specification](../../spec/06-delivery/windows-internal-release.md),
  [failure matrix](failure-matrix.md) and
  [sanitized historical live report](../conductor-smoke/live-seven-agent-report.md).

## Qualification and evidence

Baseline source is `cf3b69b585323c3908a615cdaffadb78e319bcbc` (fork PR #7).
Full Windows JS and Rust baselines and candidate runs are retained locally;
the matrix lists each observed failure and its reproduction/classification.
Windows is not a substitute for macOS signing or POSIX SSH qualification.
No test is removed, newly skipped or weakened to manufacture a green suite.

`e2e-windows-package.mjs` uses the actual unpacked package, not a development
Electron wrapper. It verifies ASAR main/preloads/renderer, x64 host and runtime
byte matches, bundled Hassan, real version/host handshake, sandbox, fork update
resources with disabled internal updater, isolated default data, single-instance,
settings/session/pet persistence across restart and screenshot hashes. Existing
capture mode only suppresses application quit confirmation. The smoke performs
no chat dispatch, microphone recording, speech or image generation.

The private final candidate manifest records exact source/base/tree, check
commands and exit codes, PR integration tree, installer filename/size/SHA-256,
PE versions, Authenticode, build environment, packaged resource hashes and
smoke evidence. Final binaries and private runtime profiles are deliberately
not source files. A provisional dirty-source build is not final provenance.

Existing toolchains/caches are reused. Builder's bounded packaging downloads
were Electron 43.6.0, NSIS 3.0.4.1, 7zip-win-x64 and NSIS resources 3.4.1;
there was no manual dependency installation or certificate acquisition.
The installer is **NotSigned**; generic builder signing messages are not
signature evidence. Unknown publisher, SmartScreen or UAC warnings may appear;
none may be disabled or bypassed.

## Blocked and unaccepted gates

No known lawful existing Windows ISO/VHDX is available. Hyper-V is available,
but no guest is created without that image. Real install, lower same-identity
baseline upgrade, uninstall, guest registration/shortcut inspection and guest
screenshots are **blocked / not verified**. Unpacked smoke is not equivalent.
Uninstall data preservation is configured, not guest-proven.

Physical dictation, real AI-generated pet and animation quality remain
**not accepted**. Physical mixed-monitor/disconnect checks are deferred.
No new live provider calls or spending is authorized. A green source PR may
land with these explicit gates, but cannot establish public release readiness.
