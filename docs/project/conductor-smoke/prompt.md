# Full Conductor team-view smoke test

Act as the main Conductor. Answer in Danish. Run one bounded UI/delegation smoke test, not a production implementation or a seven-stage gated workflow.

Run ID: CON-TEAM-UI-001. Use this ID only for this first attempt; use a new attempt suffix if repeating the test.

Authority: read-only source inspection and exactly seven direct Task delegations. Do not modify any files, execute shell commands, install anything, access external services, commit, push, restart processes, or delegate recursively. The built-in fixer and test-runner have broader tool capabilities, but this dispatch does NOT authorize those capabilities. Do not perform a live provider/API probe from any specialist.

Source input, using these workspace-relative paths to avoid the previous apps/ working-directory mismatch:
- AVATAR = apps/desktop/src/components/AgentAvatar.tsx
- TOPOLOGY = apps/desktop/src/features/chat/transcript/SubagentDetail.tsx

Preflight:
1. Inspect the actual Task tool catalog. Required delegate handles: explorer, strategist, code-reviewer, fixer, test-runner, integrator, arbiter.
2. If any handle is unavailable, STOP and list the missing handles. Do not substitute another agent, simulate a specialist, or change the registry.
3. Read the two source files. If the paths are outside the selected project's permitted root, STOP and ask the user to select the repository root. Do not broaden permissions.
4. State the scope, constraints, and acceptance criteria below before dispatch. No role needs a previous specialist's result; all seven tasks are independent for this UI smoke test.

Launch ALL SEVEN Task calls IN THE SAME ASSISTANT MESSAGE, so they belong to one fan-out group. Do not start one role, await it, and then start the next. Do not put all seven role names into one Task call.

Every dispatch must be self-contained: include run_id, the exact role and objective, both absolute source paths where relevant, the read-only restrictions above, and the required report format. Each specialist must use Read on at least one relevant source file and cite its actual path and relevant lines. Each report is at most 150 Danish words and includes run_id, role, status, evidence, findings and recommendation. No specialist may claim that automated tests ran.

Use these exact handles and independent objectives:

A. agent=explorer, description="Detective: kortlæg roller"
   Read AVATAR. List the eight canonical Conductor roles and identify which role is the main coordinator. Report the source evidence, not a guess from the screenshot.

B. agent=strategist, description="Strategist: planlæg UI-test"
   Read TOPOLOGY. Propose three manual checks for this seven-role fan-out: initial idle placeholders, active/completed cards, and selecting a card to inspect that delegate's transcript. Do not claim to have performed those UI checks.

C. agent=code-reviewer, description="Devil's Advocate: udfordr bevis"
   Read TOPOLOGY. Explain why a dimmed role placeholder is not evidence of a Task call. Identify one concrete limitation of what this graph can prove, with source lines. Do not invent a defect if none is established.

D. agent=fixer, description="Headsman: udarbejd eksempel"
Read AVATAR. Produce a small Markdown table listing the four builtin-to-role aliases as the findings in your compact report. This is an in-message artifact: do not write or edit a file, suggest a code patch, use Bash, or make product changes.

E. agent=test-runner, description="Auditor: verificér mapping"
   Read AVATAR. Manually verify these seven cases against the source: explorer->detective, strategist->strategist, code-reviewer->devils-advocate, fixer->headsman, test-runner->auditor, integrator->integrator, arbiter->arbiter. Report PASS/FAIL per case as STATIC SOURCE INSPECTION, not as an executed unit test. Do not run shell commands.

F. agent=integrator, description="Integrator: saml rolleinventar"
   Read AVATAR and TOPOLOGY. Assemble an eight-row inventory: main Conductor plus the seven handles above, canonical role, and how each is represented (coordinator node or Task card). You have not received other specialists' results; do not claim to integrate unseen reports.

G. agent=arbiter, description="Arbiter: vurder statisk dækning"
   Read AVATAR and TOPOLOGY. Independently decide whether the seven selected handles can statically cover all seven specialist roles, with Conductor as main agent. State a narrow verdict on STATIC COVERAGE only, and list what runtime/UI evidence remains necessary. Do not certify this entire run before the other results exist.

After dispatch:
- Wait for all seven actual delegation IDs using TaskWait; do not re-dispatch completed work or busy-poll.
- Record any failed/cancelled delegation truthfully. No automatic rework or additional specialists in this attempt.
- Return a seven-row result table: canonical role, exact handle, actual delegation ID, terminal status, and short evidence from the returned report.
- Distinguish runtime completion evidence from manual UI evidence. Do not infer screenshots, tool permissions exercised, or user clicks that you did not observe.

Acceptance:
- Exactly seven distinct direct Task delegations, one for every specialist role, all under this main Conductor.
- All seven return successfully, each with an actual source Read and a substantive role-specific report.
- In the same fan-out group, the user should see the main Conductor and seven real Task cards with the correct portraits; no specialist remains only a dimmed placeholder.
- Selecting each card should show the matching delegate transcript. This is a USER MANUAL CHECK unless an authorized UI tool actually verifies it.
- No writes, shell commands, nested delegation, or other unapproved side effects occur.

Conclude with separate verdicts: DELEGATION PASS/FAIL, STATIC ROLE COVERAGE PASS/FAIL, and UI MANUALLY VERIFIED/PENDING. Do not call the entire test passed while the required UI evidence is still pending.
