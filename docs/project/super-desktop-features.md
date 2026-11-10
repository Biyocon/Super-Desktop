# Super-Desktop fork feature history

This is the publishable engineering summary. Machine-local memory, credentials,
activation backups, original agent profiles and runtime data remain outside it.

| Delivery | History | Result |
|---|---|---|
| Conductor portraits/full-team visualization and initial fork identity | [PR #1](https://github.com/Biyocon/Super-Desktop/pull/1), implementation `2bf6f22d2` | Main coordinator plus seven visible role slots; actual Task participants and dimmed unused roles |
| Safe importer collision handling | [PR #2](https://github.com/Biyocon/Super-Desktop/pull/2) | Parent-folder fallback for unnamed profile.md; collisions rejected before writing |
| Separate CustomAgents library | [PR #3](https://github.com/Biyocon/Super-Desktop/pull/3) | Read-only source, no-clobber, bounded parser-validated import; registry preserved |
| Selectable library in Settings | [PR #4](https://github.com/Biyocon/Super-Desktop/pull/4) | Qualified IDs, default-off library records, activation, migration and config-sync exclusions |
| Super-Desktop product name | `c1502bb83` | User-facing product rename; compatible technical application IDs retained |
| Builtins outside the user budget | `0d87930b6` | TS runtime catalog and Rust reconciliation count only user handles; explicit builtin-off respected |
| Native Mini, gallery, safe pet import, draft dictation and confirmed AI task | `2de387294` plus this delivery | Host-owned preferences/catalog, restricted Mini, original Hassan atlas, real selected-session status and draft-only speech |
| Fork README and reproducible screenshots | This delivery | Fork additions separated from inherited upstream features; generic fixtures clearly labeled |
| User budget and Conductor lifecycle regressions | Unreleased; [test procedure](conductor-smoke/README.md#automated-lifecycle-regression-external-provider-fixture) | Settings excludes builtins; independent same-role Tasks remain visible; terminal Task snapshots persist; reload restores activity; isolated Windows native input/failure/cancellation/restart coverage |

## Preserved experiment

The earlier four-frame GIF-only Hassan home mascot is retained on
[`archive/hassan-home-mascot`](https://github.com/Biyocon/Super-Desktop/tree/archive/hassan-home-mascot).
It is superseded by the selectable atlas runtime and is not part of the current
implementation path. Do not merge its old GIF-specific design contract over Mini/pets.

## Acceptance evidence

- Pet host tests: seven; shared pet/keyboard tests: twenty-five.
- Mini/UI/service tests, locale interpolation and draft-cache regressions are in
  `apps/desktop/test/`.
- `scripts/e2e-mini-pets.mjs` runs the actual isolated product app and checks
  native import, one Mini, saved preferences, restricted preload, draft workflow,
  cleanup, confirmed normal-task launch and screenshot fixture scenes.
- [Screenshot provenance](../image/readme/super-desktop/README.md) records exact
  images. Conductor uses a seeded transcript and the library uses one generic
  disabled record; neither is production-agent execution evidence.
- [Seven-role read-only smoke guide](conductor-smoke/README.md) preserves the
  reusable prompt and role definitions without local registry/activation backups.

The documentation screenshot does not close the live seven-agent acceptance gate.
Physical microphone/production speech, paid generated-atlas quality and fresh
macOS/Linux native behavior are not certified by the local fixture checks.

## Landing-only check corrections

Publication exposed two stale test expectations: a mojibake Chinese branding
string and a window-group list that predated toggleMini. These assertions now
match the unchanged locale and the actual additive shortcut contract. One
builtin-budget regression assertion was rustfmt-normalized. No runtime feature
or unrelated SSH implementation was changed for these landing checks.

The full Windows desktop suite also contains platform/environment-sensitive
failures outside this feature. The pull-request Linux build/test results are the
integration gate; a failing required check is not bypassed.
