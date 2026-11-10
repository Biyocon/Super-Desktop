# Read-only seven-role Conductor smoke test

This package preserves the reusable, non-private part of the local test setup.
It contains a prompt and three generic user-role definitions, not an installer,
registry backup or proof of a completed production run.

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

## Cleanup and known limitation

Disable/remove only definitions introduced for your attempt, then restore only
user choices you recorded. Never restore a whole registry backup over newer work.
The existing Settings active-count guard still counts builtins; do not disable
extra unrelated agents or edit activation JSON to bypass it. Stop and report the
error instead. Host/runtime enforce the 16-user-handle budget correctly.

No machine-specific activation files, personal agent profiles, credentials or
local setup journals are published with this package.
