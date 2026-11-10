# Historical seven-agent live Conductor smoke

Status: historical technical evidence, not current installer acceptance.

## Revision and method

The Windows Electron run on 2026-11-10 used merged source
[`3c52b9f794b3fde9375304cf88c0671a4fd2c0eb`](https://github.com/Biyocon/Super-Desktop/commit/3c52b9f794b3fde9375304cf88c0671a4fd2c0eb),
with executable tree `4f76e5cbe92d97e1367a9df11762d8d121216fb3`.
The already-built candidate had that same tree; this was not a fresh rebuild.
It used the then-configured DeepSeek `deepseek-flash` model with low thinking.
Real model calls occurred. No new provider calls were made to prepare this report.

Seven real Tasks (Detective, Strategist, Devil's Advocate, Headsman, Auditor,
Integrator, Arbiter) started within a 2 ms interval. One TaskWait returned all
seven completed. The observed parent/child audit contained 7 Task, 1 TaskWait,
15 Read and 4 Grep rows; no Bash, Edit, Write or nested Task was observed.
This demonstrates concurrent delegation and read-only tool use, not a serial,
gated seven-stage production Conductor workflow.

## What the UI checks prove

The rendered group contained a coordinator, seven completed Task cards,
seven role-specific portraits and no idle placeholders. Each actual DOM button
was activated through its public UI handler. Its `aria-controls`, detail identity
and child Read rows matched the corresponding delegation. Nine cropped CDP
screenshots and their SHA-256 records remain in private local evidence.

**Historical panel activation was DOM-based**, not submitted native mouse or
keyboard input. Initial coordinate attempts hit the containing group while
scrolling. This run does not establish physical-mouse, keyboard-only,
screen-reader, all-running-screen or installer acceptance. No artificial delays
or extra model run were introduced to obtain an all-running screenshot.

## Prompt deviations retained

- Strategist and code-reviewer inspected the additional related read-only files
  `ToolRow.tsx` and `subagent-topology.ts`, beyond the two requested entry files.
  The strict two-file restriction was not fully followed.
- Whitespace-counted report lengths exceeded the 150-word limit for explorer
  (184), code-reviewer (160), and integrator (153). The reports were not rewritten.
- Some model reports claimed “only Read”; recorded Grep rows take precedence
  over those self-descriptions.

Delegation and panel routing passed their bounded checks. Strict prompt
compliance did **not** fully pass.

## Separate later fixture evidence

The later source candidate
[`97b628e09e2a243c123d5fca99294f6c638abb55`](https://github.com/Biyocon/Super-Desktop/commit/97b628e09e2a243c123d5fca99294f6c638abb55)
added [native Conductor regressions](../../../scripts/e2e-conductor-regressions.mjs):
submitted mouse press/release and focused Enter/Space, matching detail panels,
failure/cancel truth, resumed-task identity and restart/reload behavior. Its
provider-boundary fixture was deterministic; it was **not another live-model test**.

Mini candidate
[`41f84528e52644935fbf11c82d74202c503ffa3d`](https://github.com/Biyocon/Super-Desktop/commit/41f84528e52644935fbf11c82d74202c503ffa3d)
used [separate native Mini fixtures](../../../scripts/e2e-mini-pets.mjs).
Neither fixture certifies physical dictation, generated AI-pet animation quality,
or physical mixed-monitor/disconnect behavior.

## Privacy and reproducibility limits

Raw conversations, personal agent definitions, complete profiles, local private
paths, unrelated titles, credentials and raw screenshots are deliberately not
published. A local checker verified seven completed delegates, source Read
provenance, matching panels/portraits, nine screenshot hashes and cleanup;
seven negative controls rejected corrupted evidence. Registry document hashes
were preserved, and temporary activation changes were restored through the app API.
The public report is a sanitized account, not a public raw-evidence replay kit.
See the [smoke index](README.md) for the distinction from seeded README screenshots.
