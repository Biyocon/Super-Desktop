# Documentation audit reconciliation — 2026-11-15

Scope: the 62 findings retained after the isolated documentation-skill pilot, plus the Conductor index mismatch that was corrected only in that pilot copy. The live product was inspected at 4e3e6d9ed8f1102142ed2fb8f871a34e499c53da.

This is documentation maintenance. Existing decision IDs, record bodies, alternatives, historical versions, partial implementation limits and release qualifications remain unchanged. Index statuses now repeat their owning ADRs; this does not create approval, implementation, test or release evidence. The previous index text is retained below, including amendment and supersession annotations. The linked records and successor decisions remain the authority for which clauses apply.

## Classification

All 63 live findings were reviewed: 40 repeated ADR statuses, 21 links to missing VitePress heading IDs and two literal UI interpolation examples. The last two were not missing documentation; code formatting now identifies their syntax. The broken anchors were compared with rendered VitePress HTML. No baseline or ignore rule was added.

## Retained ADR index text

| Decision | Previous index text (historical) | Owning record status repeated in index |
|---|---|---|
| [harness-conductor-adapter](../adr/harness-conductor-adapter.md) | Proposed | Accepted |
| [0008](../adr/0008-plugin-runtime-isolation-target.md) | Accepted (Target) | Accepted (Implemented 2026-07-29) |
| [0011](../adr/0011-host-rpc-and-storage-defaults.md) | Accepted | Accepted; mode-profile clause superseded in part by ADR 0053 |
| [0030](../adr/0030-turn-boundary-context-checkpoint-compaction.md) | Accepted | Accepted; soft-boundary, model-tool, and visibility clauses superseded in part by ADR 0061, then partly restored by ADR 0064 |
| [0039](../adr/0039-plugin-skills-activation-and-devkit.md) | Accepted (skill delivery revised by D174) | Accepted |
| [0046](../adr/0046-categorized-process-logs.md) | Accepted | Accepted; timing-specific clauses superseded by ADR 0212 |
| [0049](../adr/0049-context-compaction-failure-recovery.md) | Accepted (preflight guard amended by ADR 0282) | Accepted |
| [0054](../adr/0054-selectable-command-shell-catalog.md) | Accepted for implementation | Accepted for implementation (timeout bounds in §4 amended by ADR 0167 / D329; the PowerShell 7 entry is added by ADR 0209 / D381) |
| [0056](../adr/0056-extension-activation-scope.md) | Accepted | Accepted (capability storage and UI portions superseded by ADR 0112) |
| [0058](../adr/0058-extensions-page-density-and-button-contrast.md) | Accepted | Accepted (IA amended by ADR 0112) |
| [0061](../adr/0061-imperceptible-background-context-compaction.md) | Accepted (amends 0030 / 0049; clauses 2/4/6/7/8 amended by 0064) | Accepted (clauses 2, 4, 6, 7, 8 amended by ADR 0064) |
| [0062](../adr/0062-bounded-subagents-behind-a-task-tool.md) | Accepted for implementation (`maxTurns` clause withdrawn by 0253) | Accepted for implementation (definition roots amended by ADR 0112; timeout policy amended by ADR 0119; delegation presentation amended by D265; opt-in parent-tool inherit amended by ADR 0246; resumable delegations amended by ADR 0279) |
| [0063](../adr/0063-subagent-management-ui.md) | Accepted for implementation (`maxTurns` field withdrawn by 0253) | Accepted (amended by ADR 0112) |
| [0064](../adr/0064-codex-parity-context-compaction.md) | Accepted (amended by D623 / issue #970: 90% inline trigger) | Accepted (automatic trigger amended by D623 / issue #970) |
| [0085](../adr/0085-work-panel-shortcut-toggle.md) | Accepted (amends 0068) | Accepted for implementation |
| [0087](../adr/0087-line-anchored-edit-contract.md) | Accepted for implementation (amends 0043 / 0069) | Implemented (phases 1–2; block ops, drift recovery, and boundary repair remain phased) |
| [0088](../adr/0088-declared-file-scope-for-plugins.md) | Accepted (continues 0008 D009) | Accepted (Implemented 2026-08-15) |
| [0089](../adr/0089-proactive-background-subagent-delegation.md) | Accepted for implementation | Accepted for implementation (resumable delegations amended by ADR 0279) |
| [0102](../adr/0102-publisher-owned-plugin-source-and-git-hosted-artifacts.md) | Accepted for implementation (supersedes 0006) | Accepted for implementation |
| [0118](../adr/0118-renderer-owned-queued-prompts.md) | Accepted | Accepted (Implemented 2026-08-24) |
| [0119](../adr/0119-event-driven-subagent-timeouts.md) | Accepted for implementation (killing policy amended by 0166; `maxTurns` clauses withdrawn by 0253) | Accepted for implementation; amended by ADR 0129 |
| [0126](../adr/0126-agent-capability-workbench.md) | Accepted (`maxTurns` clause withdrawn by 0253) | Accepted |
| [0129](../adr/0129-idle-watchdog-bounds-silence.md) | Amended by 0166 (watchdogs no longer kill) | Accepted for implementation (amended by ADR 0166: watchdogs no longer kill; the parent judges subagent lifetime) |
| [0152](../adr/0152-eight-frame-empty-home-mascot-gif.md) | Accepted | Superseded for the Super-Desktop pet integration |
| [0158](../adr/0158-approval-card-focus-and-remembered-mode.md) | Accepted | Accepted for implementation |
| [0165](../adr/0165-withdraw-a2a-peer-stack.md) | Accepted (supersedes 0147 / 0162 / 0164) | Accepted |
| [0166](../adr/0166-parent-judged-subagent-lifetime.md) | Accepted (amends 0089 / 0119 / 0129; fatal-error path amended by 0189; `maxTurns` backstop withdrawn by 0253) | Accepted for implementation |
| [0167](../adr/0167-agent-chosen-bash-timeout.md) | Accepted (amends 0054 / D190 / D273) | Accepted for implementation |
| [0176](../adr/0176-per-provider-user-agent.md) | Accepted (amends 0095 / 0156; header map superseded by 0178) | Accepted |
| [0189](../adr/0189-parent-fatal-error-aborts-leftover-delegates.md) | Accepted (amends 0166 / D328) | Accepted for implementation |
| [0205](../adr/0205-remote-agent-control-boundary.md) | Accepted for implementation (post-MVP; amended by D374, D375, and D385) | Accepted for implementation (post-MVP); amended by D374 and D375 |
| [0214](../adr/0214-trusted-extensions.md) | Accepted (v1 implemented; amended by D388 / ADR 0215) | Accepted (v1 implemented 2026-09-10) |
| [0215](../adr/0215-agent-extensions-as-plugin-contribution.md) | Accepted (implemented) | Accepted (implemented 2026-09-11) |
| [0233](../adr/0233-renderer-owned-multi-folder-project-creation.md) | Accepted (amends ADR 0011 / ADR 0016) | Accepted; behavior superseded in part by ADR 0249 |
| [0238](../adr/0238-three-column-width-priority.md) | Accepted (amends ADR 0226) | Accepted (sidebar width clamp amended by ADR 0290) |
| [0248](../adr/0248-plugin-theme-assets-and-window-background.md) | Accepted (issue #335) | Accepted for implementation |
| [active-turn-steering](../adr/active-turn-steering.md) | Accepted (active-turn-steering; issue #164) | Accepted |
| [0253](../adr/0253-remove-subagent-turn-limit.md) | Accepted (supersedes the `maxTurns` clauses of 0062 / 0063 / 0119 / 0126 / 0166 / 0210) | Accepted |
| [0270](../adr/0270-builtin-subagents-can-be-disabled.md) | Accepted for implementation (amends ADR 0063; ADR 0112) | Accepted |
| [0268](../adr/0268-remove-quotes-annotations-and-side-chats.md) | Accepted (supersedes message-quotes-and-side-chats / response-annotations / floating-annotation-index) | Accepted |

## Link and literal-example review

| Document | Previous finding | Resolution |
|---|---|---|
| [message-quotes-and-side-chats.md](../adr/message-quotes-and-side-chats.md) | token:{{title}} | Code-format {{title}} |
| [06-settings-ia.md](../spec/04-ux/06-settings-ia.md) | anchor:08-component-spec.md#18-import-destination@Import | 08-component-spec.md#_18-import-destination |
| [06-settings-ia.md](../spec/04-ux/06-settings-ia.md) | anchor:08-component-spec.md#185-modelconfigimportpanel@Import | 08-component-spec.md#_18-5-modelconfigimportpanel |
| [07-ui-design-system.md](../spec/04-ux/07-ui-design-system.md) | anchor:08-component-spec.md#17-toast@11.8 Toast | 08-component-spec.md#_17-toast |
| [08-component-spec.md](../spec/04-ux/08-component-spec.md) | anchor:07-ui-design-system.md#118-toast@17.2 Anatomy | 07-ui-design-system.md#_11-8-toast |
| [09-interaction-patterns.md](../spec/04-ux/09-interaction-patterns.md) | token:{{when}} | Code-format {{when}} |
| [03-ai-development-workflow.md](../spec/06-delivery/03-ai-development-workflow.md) | anchor:06-release-runbook.md#41-mandatory-release-version-surface-gate-d164--d260@Release / version-tag gate | 06-release-runbook.md#_4-1-mandatory-release-version-surface-gate-d164-d260 |
| [05-change-checklist.md](../spec/06-delivery/05-change-checklist.md) | anchor:03-ai-development-workflow.md#r5--verify-linked-github-issues-before-work-then-reply-and-close@0. GitHub Issue Intake | 03-ai-development-workflow.md#r5-—-verify-linked-github-issues-before-work-then-reply-and-close |
| [05-change-checklist.md](../spec/06-delivery/05-change-checklist.md) | anchor:03-ai-development-workflow.md#r6--land-a-linked-pull-request-only-when-it-fixes-the-root-cause-with-a-minimal-diff@0.1 GitHub Pull Request Intake | 03-ai-development-workflow.md#r6-—-land-a-linked-pull-request-only-when-it-fixes-the-root-cause-with-a-minimal-diff |
| [05-change-checklist.md](../spec/06-delivery/05-change-checklist.md) | anchor:03-ai-development-workflow.md#3-spec-update-matrix@2. Impact Analysis | 03-ai-development-workflow.md#_3-spec-update-matrix |
| [05-change-checklist.md](../spec/06-delivery/05-change-checklist.md) | anchor:06-release-runbook.md#41-mandatory-release-version-surface-gate-d164--d260@7. App version release checklist (stable tag) | 06-release-runbook.md#_4-1-mandatory-release-version-surface-gate-d164-d260 |
| [05-change-checklist.md](../spec/06-delivery/05-change-checklist.md) | anchor:03-ai-development-workflow.md#r4--request-branch--worktree--merge-gate@8. Final Definition-of-Done Gate | 03-ai-development-workflow.md#r4-—-request-branch-worktree-merge-gate |
| [05-change-checklist.md](../spec/06-delivery/05-change-checklist.md) | anchor:03-ai-development-workflow.md#2-development-loop@8. Final Definition-of-Done Gate | 03-ai-development-workflow.md#_2-development-loop |
| [05-change-checklist.md](../spec/06-delivery/05-change-checklist.md) | anchor:03-ai-development-workflow.md#r1--spec-first--spec-sync@8. Final Definition-of-Done Gate | 03-ai-development-workflow.md#r1-—-spec-first-spec-sync |
| [05-change-checklist.md](../spec/06-delivery/05-change-checklist.md) | anchor:03-ai-development-workflow.md#r3--e2e-coverage-doc@8. Final Definition-of-Done Gate | 03-ai-development-workflow.md#r3-—-e2e-coverage-doc |
| [05-change-checklist.md](../spec/06-delivery/05-change-checklist.md) | anchor:03-ai-development-workflow.md#r2--commit-per-change@8. Final Definition-of-Done Gate | 03-ai-development-workflow.md#r2-—-commit-per-change |
| [05-change-checklist.md](../spec/06-delivery/05-change-checklist.md) | anchor:03-ai-development-workflow.md#44-never-commit@8. Final Definition-of-Done Gate | 03-ai-development-workflow.md#_4-4-never-commit |
| [05-change-checklist.md](../spec/06-delivery/05-change-checklist.md) | anchor:#61-merge-cleanup-checklist@8. Final Definition-of-Done Gate | #_6-1-merge-cleanup-checklist |
| [05-change-checklist.md](../spec/06-delivery/05-change-checklist.md) | anchor:03-ai-development-workflow.md#r5--verify-linked-github-issues-before-work-then-reply-and-close@8. Final Definition-of-Done Gate | 03-ai-development-workflow.md#r5-—-verify-linked-github-issues-before-work-then-reply-and-close |
| [05-change-checklist.md](../spec/06-delivery/05-change-checklist.md) | anchor:03-ai-development-workflow.md#r6--land-a-linked-pull-request-only-when-it-fixes-the-root-cause-with-a-minimal-diff@8. Final Definition-of-Done Gate | 03-ai-development-workflow.md#r6-—-land-a-linked-pull-request-only-when-it-fixes-the-root-cause-with-a-minimal-diff |
| [06-settings-ia.md](../zh-CN/spec/04-ux/06-settings-ia.md) | anchor:/zh-CN/spec/04-ux/08-component-spec#18-导入目的地@导入 | /zh-CN/spec/04-ux/08-component-spec#_18-导入目的地 |
| [06-settings-ia.md](../zh-CN/spec/04-ux/06-settings-ia.md) | anchor:/zh-CN/spec/04-ux/08-component-spec#185-modelconfigimportpanel@导入 | /zh-CN/spec/04-ux/08-component-spec#_18-5-modelconfigimportpanel |
| [decisions-log.md](../zh-CN/spec/08-meta/decisions-log.md) | anchor:../../../spec/08-meta/decisions-log.md#_2026-09-14-preserve-local-annotation-and-side-chat-contracts-across-upstream-integration@2026-09-14 — Upstream integration compatibility | ../../../spec/08-meta/decisions-log.md#_2026-09-14-—-preserve-local-annotation-and-side-chat-contracts-across-upstream-integration |

## Validation scope

Run the existing agent-policy, documentation and locale checks, plus VitePress build and the same external audit configuration. Machine-readable before/after reports and the SHA-256-protected edit plan are stored with the task artifacts outside the repository. Product behavior, installers and live providers are outside this documentation-only change. Existing missing-Consequences notices are not new failures.
