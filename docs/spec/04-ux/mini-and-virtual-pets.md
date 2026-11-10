# Mini and virtual pets (Super-Desktop)

Status: implementation candidate. See [ADR](../../adr/mini-and-virtual-pets.md).

## User path

Settings includes a searchable Mini and virtual pets destination under
Preferences. It shows the selected pet, real animation previews, None,
Hassan, user imports, refresh, import, and AI-create controls. Selecting a
card persists through host-core; saving failure preserves the previous
choice and is visible. None remains None after restarting. Selecting None
removes the welcome figure, not the Mini controls.

Hassan is supplied by the owner and bundled independent of `.codex` being
installed. Other ChatGPT builtin pets are not copied. Valid user-owned
pet.json plus spritesheet.webp/png packages are imported through the native
picker, structurally checked, decoded, previewed, then explicitly installed.
No package is allowed to contribute scripts, URLs or filesystem authority.
A fingerprint change after preview requires a new preview. Duplicate ids
are refused; existing pets are not overwritten.

## Atlas contract

Cells are 192x208, eight columns. V1 is nine rows (1536x1872), v2 eleven rows
(1536x2288). Absent spriteVersionNumber means v1. Standard rows and timing
are defined in packages/shared/src/pets.ts from the supplied atlas reference.
V2 rows 9/10 contain sixteen clockwise directions, starting with screen-up;
the pointer deadzone is idle. Do not rotate the whole sprite to fake gaze.
Reduced motion always uses the first idle frame. Animation listeners and
frame schedules are released when hidden or unmounted.

## Mini

Mini is one transparent, draggable, sandboxed window with no taskbar entry.
Vis/Hide, position, scale, always-on-top and pointer following are host-owned
preferences. A new profile starts hidden. A saved position is clamped to a
current display's work area. Show/focus/rebind must never mint duplicates.
The shortcut is configurable through the existing keyboard registry; the
initial proposal is Ctrl+Alt+P (Cmd+Alt+P on macOS), avoiding the screenshot's
Windows-specific hardcoded chord and reporting real registration conflicts.
Pointer following is local to the Mini window; no global cursor polling is used.

The control capsule provides new task, dictation and a menu with pet settings
and hide. New task uses existing application session creation. Mini does not
run agents or approve requests. Its activity belongs to the current selected
session, not the latest arbitrary background task. Waiting/error/review/running
are projected only from actual application state. Do not display invented
progress. Reload/session changes invalidate stale callbacks.

## Dictation

Use the existing configured speech-input path; no new voice provider engine.
Configure transcription in Settings > Mini and virtual pets > Dictation provider:
choose an existing enabled provider, a supported transcription protocol and model
ID, then Save. None disables transcription without removing synthesis settings.
Keys remain in the existing provider store. The separate legacy Voice page is
not this capability's configuration path. Compatible custom path/extra fields
survive a model-only edit.
Microphone permission and visible capture state are required. A completed
transcription becomes a draft, preserving existing draft text, and never
submits automatically. Cancellation/session switch/close cannot insert a
late transcription into another session. If speech is unavailable, provide
a visible configuration path, not a fake successful recording. Do not begin
live speech/model calls from tests without explicit authorization.
The Mini session permits audio only during an explicitly issued capture token.
Capture is bounded to 60 seconds / 25 MB. Hide, close, renderer reload, speech
unavailability and selected-session changes invalidate capture/result identities.
Temporary session audio is deleted after transcription. A result stays editable
in Mini until the owner chooses Open draft; existing composer text/attachments
are preserved. Cancelling cannot revoke an already dispatched provider request,
but its late result is discarded.

## AI creation

AI creation collects the requested identity/description, explains provider
usage and obtains confirmation before starting a normal, bounded agent task.
It uses the existing image-generation path and supported pet-creation guidance,
not ChatGPT's private Pets MCP. Progress/failure/cancel are visible in that
task's transcript. The output is a full v2 package plus motion previews and
quality evidence, not a static mascot or a filename invented in a reply.
The owner reviews and imports the produced package via the same validated
preview-and-confirm path; success text alone never installs a pet. No inert
button or plain import may be labeled as completed AI generation.

## Validation

Cover absent/existing preference restart, valid and invalid import, stale
preview, duplicate id, source preservation, light/dark, None, all animation
rows and look directions, reduced motion, listener cleanup, native-window
lifecycle, sender authorization, keybinding conflicts, selected-session
status, draft-only voice and the confirmed AI-task entry point. Isolated
Electron acceptance must not use the owner's running app as a test fixture.
Paid-provider acceptance not run locally must be explicitly reported.

Run `node scripts/e2e-mini-pets.mjs` after the candidate shared/desktop and host
builds. It uses isolated data/profile/agent paths and the actual product app;
the native picker and external media capture are fixtures; speech and agent calls
reach a loopback HTTP provider. It also exercises denied permission and missing
microphone at the external media boundary, cancellation, a real transport error
and successful retry. The composer picker/import path attaches a harmless file;
edited Open draft preserves existing text plus attachment token/path/identity,
while Discard leaves them unchanged. Neither action starts a chat or user turn.
Tracks and temporary audio are cleaned after failure and success. These are
boundary-fixture checks, not physical microphone or real-provider acceptance.
Result artifacts identify the candidate/base, dirty state and screenshot hashes.
Component and service tests cover stale results, animation and cancellation.

Physical/provider acceptance is separate: record only with explicit informed
user start, verify transcription with the user and document a reliable combined
cost bound before any live request. Missing bindings or unknown prices block the
request rather than authorizing a substitute provider. Record physical Windows
scaling/movement/restart checks separately from simulated display geometry and
restore changed settings. Missing extra displays leave multi-monitor/disconnect
acceptance deferred. Generated pet acceptance requires an actual full v2 output,
motion/contact-sheet QA and explicit reviewed import; a fixture task reply or
reimport of bundled Hassan cannot substitute for newly generated pet quality.

On Windows, Electron nativeImage cannot decode WebP directly. An ephemeral
sandboxed Chromium renderer decodes imported WebP with no preload, network or
permissions; the decoded bitmap is checked for exact geometry, transparency and
visible art in every required cell before a five-minute installation token is
issued. Confirmation is single-use, owner-bound and fingerprint-revalidated.
