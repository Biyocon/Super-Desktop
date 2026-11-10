# ADR: Separate Super-Desktop identity on Windows

- Status: Accepted
- Date: 2026-11-10
- Deciders: Super-Desktop maintainer

## Context

The fork's visible name was Super-Desktop, but Windows still packaged the
PI-Desktop executable and application ID. Reusing them could replace the
installed upstream app or share native attribution. Internal validation must
not consume existing PI-Desktop or development profiles.

## Decision

Use permanent Windows app ID `io.github.biyocon.super-desktop`, package name
`super-desktop`, executable `Super-Desktop.exe`, and Super-Desktop NSIS shortcut
and uninstall names. Select an explicit Windows builder overlay; do not mutate
the macOS/Linux installation contracts. Derive NSIS upgrade identity from this
new app ID and keep it stable across later Super-Desktop Windows versions.

Windows defaults become `~/.super-desktop` and `~/.super-desktop-dev`; packaged
Electron userData is `<appData>/Super-Desktop`, development is
`<appData>/Super-Desktop Dev`. Explicit data/profile overrides retain their
existing behavior, including the data-override single-instance opt-out.
There is **no automatic migration** from PI-Desktop or older fork development
profiles. Existing files remain untouched; a future explicit migration would
need its own compatibility and security decision.

Internal Windows versions containing `-super.` disable update checking,
download and installation. Packaged update resources and release links point
to `Biyocon/Super-Desktop`, never upstream. No feed is published in this task.
The internal installer is intentionally unsigned (`NotSigned`), with no
verified-publisher claim or security-warning bypass.

## Alternatives

Keeping the old ID would maintain an unsafe replacement relationship. Giving
only the visible executable a new name would leave NSIS upgrades and profiles
ambiguous. A Windows-only overlay separates identity without changing other
platforms' established contracts.

## Consequences

New Windows installs are independent, not upgrades of PI-Desktop. Later versions
with this new identity may upgrade each other; actual install/upgrade/uninstall
requires guest acceptance. Uninstall preserves application data by default
(`deleteAppDataOnUninstall: false`). It must remove only owned programs,
shortcuts and installation registration. Without a lawful existing Windows
image that guest gate is blocked, not inferred from unpacked smoke or green CI.

See the [Windows internal release specification](../spec/06-delivery/windows-internal-release.md)
and [qualification record](../project/windows-internal-release/README.md).
