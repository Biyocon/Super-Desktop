# Windows internal Super-Desktop candidate

## Identity and compatibility

Candidate: `0.15.7-super.1`, Windows x64 only. Publication is **awaiting user
acceptance**; source integration is not installer acceptance.

| Surface | Windows contract |
| --- | --- |
| Application / AUMID / NSIS upgrade identity | `io.github.biyocon.super-desktop` |
| Package / executable | `super-desktop` / `Super-Desktop.exe` |
| Product / shortcuts / uninstall display | `Super-Desktop` |
| Installed data | `~/.super-desktop` |
| Development data | `~/.super-desktop-dev` |
| Electron installed / development userData | `<appData>/Super-Desktop` / `<appData>/Super-Desktop Dev` |
| Update resources / releases | `Biyocon/Super-Desktop` |
| Internal `-super.` updater mode | disabled; no check/download/install/scheduling |
| Uninstall data policy | preserve data; remove owned program/shortcuts/registration |

Set the name/profile/AUMID before taking Electron's userData-scoped lock and
before creating children. A second default-profile launch focuses the existing
instance and exits. Explicit `--user-data-dir` wins; `PI_DESKTOP_DATA_DIR` keeps
its existing isolated-run lock opt-out. The Windows builder overlay is selected
explicitly. macOS/Linux identifiers, roots and update policy are unchanged.

Do not auto-import or migrate PI-Desktop or existing fork development data.
These are new Windows installations, not replacements for upstream. See
[identity ADR](../../adr/windows-super-desktop-identity.md).

## Build and local acceptance

Use the existing compatible Node/pnpm/Rust environment. Build JS, runtime
bundle and static-CRT x64 host in task-owned outputs, then run from
`apps/desktop`:

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
pnpm.cmd exec electron-builder --config electron-builder.windows.cjs --win nsis --x64 --publish never
```

Never execute the installer on the working host. `node scripts/e2e-windows-package.mjs`
starts only the unpacked executable, with isolated HOME/USERPROFILE, userData,
agent registry and runtime agent state. It checks actual packaged bytes,
version, sandboxed preload, host handshake, settings/session/pet restart,
single-instance and disabled updater. Existing capture mode suppresses the
application's own quit confirmation only; this is not installer or OS-warning
acceptance. No model, speech, image or microphone action is performed.

Record source commit/tree, toolchain, installer filename/size/SHA-256,
Authenticode and PE version metadata, resource hashes, screenshots and cleanup.
Private evidence and binaries stay outside source Git. Do not publish a release,
tag, installer asset or updaterfeed, or start the publishing release workflow.
Use `release.mjs <prerelease> --offline` for offline version preparation only;
`--offline` with stable versions or `--tag` is rejected before writes. The
stable-form `0.15.7` catalog is preview documentation, not proof of publication.

## Mandatory guest gate

Use one new task-owned Hyper-V guest with an **existing lawful Windows image**.
No ISO download, license acquisition, host feature/network/security changes or
restart is authorized. Share only task installers and harmless fixtures.

1. Record the lower same-identity Super-Desktop baseline version/source; identify
   a synthetic baseline as synthetic, not a previously public release.
2. Install and launch; inspect UI, files, shortcuts, registration and processes.
3. Seed harmless settings, session/history rows and pet choice; record IDs/hashes.
4. Upgrade with the final installer (or documented byte-identical candidate).
   Verify preserved identities/content and exactly one installation.
5. Uninstall: verify removal of program/shortcuts/registration, preserved data,
   stopped owned processes and screenshots at each stage.

The candidate is unsigned (`NotSigned`); Windows may show unknown-publisher,
SmartScreen or UAC warnings. Do not disable or bypass them. Required user
interaction is a blocker until supplied. No known lawful image is available in
this run: install/upgrade/uninstall is **blocked / not verified**. Do not fall
back to host installation or call the candidate installer-accepted.

Physical dictation and real generated-pet/animation quality remain **not
accepted**; physical mixed-monitor/disconnect acceptance is deferred. Full
Windows suite limitations remain visible in the [failure matrix](../../project/windows-internal-release/failure-matrix.md).
