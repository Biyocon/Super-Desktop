# Unreleased changes

- Mini regression coverage now includes permission denial, a missing microphone,
  provider failure/retry, recording cancellation, Discard and Open draft over
  existing text plus a real imported attachment. The isolated native harness
  records screenshot hashes and attachment identity, waits for complete window
  snapshots and scrolls the provider picker into view before opening its menu.
  These boundary fixtures do not certify physical speech or generated pet quality.

- Subagents Settings now counts unique active user handles across owned/library
  definitions without charging builtins against the 16-user budget. Builtins
  remain independently toggleable; rejected activation updates roll back.
- Conductor preserves every independent Task, including repeated roles and
  unknown user agents, while resumed chains retain one current card. Detail
  transcripts show truthful outcomes even when a child fails before output.
  Terminal Task snapshots now survive host deduplication without rewriting
  original metadata, and renderer reload restores main-owned live turns without
  redispatch. Isolated Windows Electron/provider-fixture regressions cover
  native mouse/Enter/Space, failure, cancellation, reload and full app restart.


- Super-Desktop now has a native Mini and virtual pets settings page with
  bundled Hassan, explicit None, v1/v2 animation and gaze, safe previewed
  imports, and persisted selection. A single sandboxed transparent Mini uses
  real selected-session activity, configurable show/hide shortcut, position,
  size and topmost preferences. Dictation uses the configured speech provider
  and only opens an editable draft; it never sends automatically. AI-assisted
  creation starts a confirmed normal agent task; installation remains a
  separate reviewed import. No private ChatGPT pet APIs or builtin art are used.

- Google Gemini rows send requests again. A provider row on the native
  generative-AI endpoint no longer hands pi-ai's Google adapter the internal
  response-capture `fetch` it refuses before the request leaves, custom provider
  headers still reach Google, and an adapter refusal now fails the turn instead
  of spending all ten transient retries on it (issue #1072).

- Deleting a provider no longer leaves a dangling image-generation default.
  An image default or marked candidate whose provider row is gone is dropped
  on the next settings read or write, instead of staying stored as a binding
  every generation request rejects as an unavailable model.

- Subagent topology cards and their live process rows now follow the main
  conversation's responsive width behavior: long descriptions, paths,
  commands, and summaries wrap inside the dock instead of requiring repeated
  divider dragging to read them.

- Resuming a subagent no longer selects another definition's private model
  binding. On-demand delegation permissions are checked again on the next parent
  turn, so revoking automatic delegation takes effect without restarting the runtime.
- Trusted extension cancellation now retires SDK commands, tool updates,
  subprocesses and queued or visible prompts. Late hook payload mutations are
  isolated; legitimate long commands and tools retain their runtime budget.

- Copy individual Markdown tables, download them as CSV, or expand them for
  reading without leaving the conversation.

- A stored hosted web-search record that cannot be replayed no longer fails every
  later request in that conversation: the message continues without search replay,
  so histories written before the contract change stay usable.

- Hosted web search now has a complete replay and estimation contract, including
  tool/Task continuation and restart recovery. Context rebuilding preserves
  system-prefix semantics, and structured local preparation failures no longer
  masquerade as retryable provider failures. Existing search histories need no migration.

- Trusted extension startup, shutdown, and notification handlers now have
  bounded waits. Stop cancels pending hook waits before a model request, and
  disposal ignores late results and runs shutdown once. Deferred event
  registrations now appear in plugin diagnostics.

- The Composer reasoning slider now moves smoothly to clicked or
  keyboard-selected levels, follows dragging immediately, and respects
  reduced-motion settings. Rapid clicks redirect the animation; failed saves
  restore the confirmed selection. Opening the menu no longer leaves a
  press-animation offset that jumps on the first selection.
- The reasoning slider's filled track covers the entire starting dot, so
  its left cap no longer leaves a gray half-dot exposed.
- Hovering a reasoning stop or its label highlights the corresponding label.
  Only unfilled dots brighten and enlarge; filled dots and the current thumb
  keep their appearance.
- OpenAI Codex OAuth models can now opt into provider-hosted native web search.
  The feature remains off by default and search history is replayed only for
  the same Codex model.
