# Mini and virtual pets in the Super-Desktop fork

Status: Accepted for implementation by the owner (2026-11-09).

## Context

The owner requested a native Settings pet library and floating Mini, starting
with the supplied Hassan v2 pet, selectable None, import and AI creation,
a configurable shortcut, real selected-session status, and draft-only
speech-to-text. An asset-only welcome-hero change is not this feature.

A plugin widget already has transparent-window capability, but making a
pet plugin impersonate native Settings would conflate plugin permission and
lifecycle boundaries with a built-in application feature. ChatGPT's private
Pets/Library services and its bundled artwork are not Super-Desktop APIs.

## Decision

- Rust host-core owns the local pet library, validated package import,
  versioned preference persistence and bundled Hassan atlas. Imported bytes
  are copied, not referenced back to Codex or executed. Existing SQLite
  schemas and AppSettings are unchanged: the new domain uses its own
  version-1 `pets/library.json` with explicit absent-file defaults.
- Shared contains data contracts, bounded validation, animation-row timing,
  directional mapping and the configurable Mini shortcut entry. Renderer
  contains presentation and user actions only, with no filesystem/SQLite.
- Electron Main owns one sandboxed native Mini window and thin IPC routing.
  Existing plugin widgets remain plugin-owned; their permissions and bridge
  are not reused to elevate the Mini surface. New IPC handlers authorize
  main and Mini senders explicitly, including frame identity.
- The default welcome artwork is Hassan; the default Mini visibility is off.
  Saved None is distinct from an absent preference. Existing user settings,
  sessions, skills, providers and Codex pet files are not rewritten.
- Import is preview then confirm with a short-lived opaque token. Confirm
  revalidates package bytes against the preview fingerprint. Native image
  decoding checks must pass before issuing a token. Metadata, atlas sizes,
  image bytes and count are bounded, and duplicate identities are refused.
- One shared atlas renderer supports the documented v1/v2 animation rows
  and v2 look directions. Reduced motion freezes to idle/neutral. Hidden
  surfaces stop animation and release owned listeners/timers.
- Mini projects the main renderer's selected-session state; it cannot start
  an agent, approve permissions or submit dictated text. Its narrow actions
  route to the main application: new task, draft dictation and pet settings.
  Stale session results must not be inserted into a different conversation.
- AI pet creation uses an explicitly confirmed, bounded creation task through
  the existing agent/image-generation path, not a second agent/model engine.
  The task exposes progress, cancel and error through the normal transcript;
  it must produce a validated v2 package, previews and QA evidence. Installation
  is still an explicit pet import/preview confirmation, never automatic based
  only on model text. No unconfigured provider is called silently.

## Alternatives

Keep the welcome GIF only: insufficient for the requested library/Mini.
A plugin: viable for an optional extension but does not meet native Settings.
Private ChatGPT service reuse: unavailable and the wrong ownership boundary.
A second native agent runtime: unnecessary, unsafe and out of scope.

## Compatibility and consequences

This adds local `pets.*` RPC and allowlisted IPC plus a dedicated renderer
surface. New files are independent of pre-existing SQLite data; an unknown
library version or corrupt file is observable, never silently reset. Import
rejects unsupported metadata/atlas geometry without changing the prior pet.
The Mini service has an explicit owner and disposal path for shutdown,
renderer reload, display changes and shortcut rebinds. Tests must exercise
those boundaries, not certify them by source-text assertions alone.

The earlier mascot ADR's eight-frame GIF artwork decision is superseded for
this fork's selected-pet hero; logo/sidebar branding is not changed. Pet
selection and Mini have one host-owned source of truth.
