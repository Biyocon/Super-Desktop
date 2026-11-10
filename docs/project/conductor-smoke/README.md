# Read-only seven-role Conductor smoke test

This package preserves the reusable, non-private part of the local test setup.
It contains a prompt and three generic user-role definitions, not an installer,
registry backup or proof of a completed production run.

The [sanitized historical live report](live-seven-agent-report.md) records a real
seven-agent run, including its prompt deviations and DOM-only panel activation.
It is separate from the later native-input fixture regressions below.

## Before running

1. Select this repository root as the project, not its `apps` directory.
2. Check the actual Task catalog for `explorer`, `strategist`, `code-reviewer`,
   `fixer`, `test-runner`, `integrator`, `arbiter`.
3. If needed, create the three generic user roles through Settings using
   `agents/*.md` as field references. Preserve existing definitions and note
   any user agents you temporarily disable. Builtins do not spend user slots.
   Do not copy YAML frontmatter into the instruction field.
4. Start a new conversation. Read [prompt.md](prompt.md), choose a fresh run ID,
   and verify that the workspace-relative source paths resolve before dispatch.

Running this prompt uses the configured model for seven delegates plus the
coordinator and can incur charges. It is not launched by opening the README.
Each dispatch is independent, read-only, non-recursive and bounded. All seven
Task calls must occur in the same assistant message to appear in one fan-out.

The builtin fixer/test-runner have broader capabilities than the three test
roles. The prompt forbids writes/shell; it is not a replacement technical sandbox.
Inspect the actual tool history before claiming those restrictions held.

## Acceptance

Record seven distinct delegation IDs, terminal results and source-read evidence.
Separately inspect the correct portraits/statuses and click each card to inspect
its matching transcript. Idle placeholders are not proof of a delegated task.
Report delegation, static source coverage and manual UI verification separately.
A sequential seven-stage workflow is not a cross-turn cumulative graph test.

The README Conductor screenshot uses the actual renderer with a **seeded
transcript fixture**. It validates the displayed topology, not successful
execution of seven production-provider delegates. The live test remains separate.

## Cleanup and user budget

Disable/remove only definitions introduced for your attempt, then restore only
user choices you recorded. Never restore a whole registry backup over newer work.
Settings and host/runtime count unique enabled owned/library user handles, not
builtins. User 16 fits alongside five builtins; a new user 17 is rejected.
Builtin toggles remain independent. Duplicate-source conflicts and failed writes
roll back without spending another user slot.

No machine-specific activation files, personal agent profiles, credentials or
local setup journals are published with this package.

## Automated lifecycle regression (external provider fixture)

Build shared/i18n/runtime and Desktop from the candidate, then run
`node scripts/e2e-conductor-regressions.mjs`. Set `PI_DESKTOP_HOST_BIN` to a host
built from the same candidate. No credentials, active registry or running user
app are used. Only the external OpenAI-compatible provider is substituted;
Task, Read, TaskStop, TaskWait, persistence, preload and UI are real.

The isolated Windows scenario checks four independent explorer cards, correct
portraits, mouse press/release and keyboard focus + Enter/Space, delegation-id
and child-row routing, completed/failed/stopped outcomes and issue group status.
It reloads during a held delegate without another dispatch, then restarts the
whole owned app during a second held delegate: history survives, completed
siblings stay completed and the interrupted delegate is stopped, not successful
or permanently running. Resume-chain cardinality is covered by component tests.

Scratch `result.json` records candidate/base commits, dirty-candidate flag,
provider request counters and interaction identities; adjacent screenshots and
histories are test artifacts, not a live-model run. Only a clean exact-commit
rerun is acceptance evidence. Do not publish raw application/profile/log folders.
