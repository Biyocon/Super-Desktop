# Mini and virtual pets — candidate validation

## Candidate

- Worktree: `.worktrees/mini-pets`, branch `feat/mini-pets`.
- Validation base / pre-commit HEAD: `0d87930b6d1c5dfb9310886b77c7db0e99832b15`.
- The checks below ran on the uncommitted candidate captured by the source hashes.
  This report accompanies its feature commit; no push, merge, deployment or primary-checkout change.
- Source-file hashes: `candidate-files.json` (pre-commit validation snapshot).
- Actual native evidence: `native-result.json`; original session scratch `mini-pets-e2e-9Rz18G/result.json`.
- [Actual isolated native screenshots](visual-review.html).

## Executed checks

| Check | Result |
|---|---|
| Desktop typecheck and candidate build | PASS; existing large-chunk build warning |
| `cargo test -p host-core --locked pets::` | 7/7 |
| Shared `pets.test.ts` and `keyboard-shortcuts.test.ts` | 25/25 |
| Desktop `mini-pets.test.mjs` and `pet-ui.test.mjs` | 18/18 |
| Desktop `pet-locales.test.mjs` and `composer-draft-cache.test.mjs` | 14/14 |
| Branding `app chrome` focused test | 1/1 |
| `node scripts/e2e-mini-pets.mjs` | 12 native scenarios; PASS |
| Style-token guard | PASS after replacing a raw font weight |
| Biome noUnusedVariables on 23 new TS/TSX modules | PASS, same rule as repository preset; scratch config because root includes omit these new domains |
| Rustfmt on four new Rust modules | PASS |
| Host Clippy, all targets, locked | PASS; four existing unrelated warnings |
| `git diff --check` | PASS |
| Pre-commit Mini/UI/locale rerun, desktop typecheck and style guard | 19/19; typecheck/style PASS; all 78 candidate file hashes unchanged |

The native harness uses the actual product renderer, restricted preloads, main process,
Rust host and normal agent runtime. Only the native picker and external media capture
are fixtures. Speech and model HTTP calls reach an isolated loopback provider.

Verified paths include None persistence, full WebP decode and explicit import,
single Mini, bounds/scale/topmost/hide/show/theme/restart, preload restrictions,
dictation configuration preserving synthesis and compatible custom fields, real
selected-session activity, record/stop/edit/Open draft preserving existing unsent
text without model submission, track/temp-audio cleanup, visible draft actions,
renderer reload, free AI review/cancel, explicit normal-task launch/full-package
prompt/transcript and no automatic pet installation.

Visual review used real native screenshots, not a component mock: light/dark gallery,
Hassan and Mini draft controls. Draft autofocus/scroll was added after this review
found that the actions initially required manual scrolling; native viewport bounds
now assert Open draft is visible.

## Preservation and compatibility

Primary main remained clean at the base hash. Existing IPC channels were retained;
new pet/Mini channels are additive. SQLite and AppSettings schemas did not change.
No packages were installed, no second key store was introduced, and no live user
registry/profile/data was used as a fixture. The bundled and original Codex Hassan
atlases both retain SHA-256:
`926ef43dd53f4232d20feb5ddcb4e011442df2ed278358b2a8cee3534a3e8c72`.

## User preview acceptance

On 2026-11-10 the user confirmed the separate-profile Super-Desktop preview with
the pet Settings page and Hassan Mini worked, then explicitly requested a commit.
This confirmation does not claim physical microphone or paid-provider acceptance.

## Verification limits

- No physical microphone or paid speech provider was used.
- No paid AI atlas was generated. The confirmed normal-task handoff and complete
  package instructions were tested, not output quality from a production model.
  Generated motion/contact-sheet/QA still require owner review and explicit import.
- Native window behavior was exercised on Windows only. No claim of macOS/Linux QA.
- Attachment preservation is implemented by leaving composer references unchanged;
  the native dictation scenario verifies existing text, not an attached-file case.
- Native OS shortcut conflict/rebind, OS close-to-hide and every media-permission
  combination were not separately automated; sender/frame checks and draft lifecycle
  have focused tests. Already-dispatched provider requests cannot be revoked;
  cancellation discards late results.
- Full repository test suites and `verify:ui:*` were not run. Known baseline full
  branding Chinese-regex and unrelated Windows Rust path failures are outside scope.
- Component tests emit the existing no-i18next-instance test warning; assertions pass.
