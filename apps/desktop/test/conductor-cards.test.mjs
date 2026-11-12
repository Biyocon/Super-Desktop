import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import * as shared from "@pi-desktop/shared";
import * as catalog from "@pi-desktop/i18n";
const require = createRequire(new URL("../package.json", import.meta.url));
const { I18nextProvider } = require("react-i18next");
const runtimeRequire = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url));
const { build } = runtimeRequire("esbuild");
const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../src/features/chat/transcript/SubagentDetail.tsx", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "cjs", external: ["react", "react/*", "react-dom/*", "react-i18next", "i18next", "@pi-desktop/*"], jsx: "automatic",
  loader: { ".css": "empty", ".png": "dataurl", ".svg": "dataurl" }, logLevel: "silent",
});
const module = { exports: {} };
const external = (id) => id === "@pi-desktop/shared" ? shared : id === "@pi-desktop/i18n" ? catalog : require(id);
new Function("require", "module", "exports", compiled.outputFiles[0].text)(external, module, module.exports);
const { SubagentTopology } = module.exports;
const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: catalog.en } }, react: { useSuspense: false } });
function item(id, agent = "explorer") {
  return { kind: "tool", message: { id, toolCallId: id, role: "tool", content: "", createdAt: "2026-11-10T00:00:00.000Z", toolName: "Task", toolStatus: "success", toolArgs: { agent, task: id, description: id }, toolResult: { details: { delegationId: `delegate-${id}`, status: "completed" } } } };
}
function render(items, props = {}) {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(SubagentTopology, { items, ...props })));
}

test("two independent tasks for one agent render two distinct selectable completed cards", () => {
  const html = render([item("first"), item("second")]);
  assert.match(html, /data-message-id="first"/);
  assert.match(html, /data-message-id="second"/);
  assert.equal((html.match(/class="subagent-topology-node-header"/g) ?? []).length, 2);
  assert.equal((html.match(/subagent-topology-idle/g) ?? []).length, 0);
  assert.match(html, /subagent-topology-root/);
});

test("only actual tasks render and unknown agent identities are not dropped", () => {
  const html = render([item("custom", "project-reviewer")]);
  assert.match(html, /data-message-id="custom"/);
  assert.equal((html.match(/subagent-topology-idle/g) ?? []).length, 0);
  assert.equal((html.match(/role="listitem"/g) ?? []).length, 1);
  assert.match(html, /class="subagent-topology-node-title">project-reviewer<\/span>/);
  assert.doesNotMatch(html, /<img\b/);
});

test("a resumed chain in one group keeps its latest card without hiding an independent peer", () => {
  const original = item("original");
  const resumed = item("resumed");
  resumed.message.toolArgs.resume = "delegate-original";
  const html = render([original, item("peer"), resumed]);
  assert.doesNotMatch(html, /data-message-id="original"/);
  assert.match(html, /data-message-id="resumed"/);
  assert.match(html, /data-message-id="peer"/);
  assert.equal((html.match(/class="subagent-topology-node-header"/g) ?? []).length, 2);
});

test("completed, failed and cancelled peers retain separate structured outcomes", () => {
  const done = item("done");
  const failed = item("failed");
  failed.message.toolResult.details.status = "failed";
  const aborted = item("aborted");
  aborted.message.toolResult.details.status = "aborted";
  const html = render([done, failed, aborted]);
  for (const outcome of ["completed", "failed", "aborted"]) assert.match(html, new RegExp(`outcome-${outcome}`));
  assert.equal((html.match(/class="subagent-topology-node-header"/g) ?? []).length, 3);
});

test("an actual Task named conductor remains selectable beside the coordinator", () => {
  const html = render([item("coordinator-role-task", "conductor")]);
  assert.match(html, /data-message-id="coordinator-role-task"/);
  assert.equal((html.match(/class="subagent-topology-node-header"/g) ?? []).length, 1);
  assert.equal((html.match(/subagent-topology-idle/g) ?? []).length, 0);
  assert.match(html, /class="subagent-topology-node-title">conductor<\/span>/);
  assert.match(html, />Main agent<\/strong>/);
});

function messageIds(html) {
  return [...html.matchAll(/data-message-id="([^"]+)"/g)].map((match) => match[1]);
}

function agentNames(html) {
  return [...html.matchAll(/class="subagent-topology-node-title">([^<]*)<\/span>/g)].map((match) => match[1]);
}

test("generic builtins and their parent keep their actual names and bot glyphs", () => {
  const names = ["explorer", "code-reviewer", "test-runner", "fixer"];
  const html = render(names.map((name) => item(`task-${name}`, name)));
  assert.deepEqual(agentNames(html), names);
  assert.equal((html.match(/role="listitem"/g) ?? []).length, 4);
  assert.match(html, />Main agent<\/strong>/);
  assert.match(html, />Coordinating 4 delegated tasks<\/span>/);
  assert.doesNotMatch(html, /<img\b|subagent-topology-idle/);
  assert.doesNotMatch(html, /The Conductor|detective|devils-advocate|auditor|headsman|strategist|integrator|arbiter/i);
});

test("actual tasks retain transcript order across builtins, explicit role names and unknown agents", () => {
  const names = ["fixer", "Arbiter", "project-reviewer", "Detective", "explorer", "conductor", "Code_Reviewer.md", "fixer"];
  const items = names.map((name, index) => item(`task-${index}`, name));
  const before = structuredClone(items);
  const html = render(items);
  assert.deepEqual(messageIds(html), items.map(({ message }) => message.id));
  assert.deepEqual(agentNames(html), names);
  assert.equal((html.match(/class="subagent-topology-node-header"/g) ?? []).length, items.length);
  assert.doesNotMatch(html, /subagent-topology-idle/);
  assert.deepEqual(items, before, "rendering must not rewrite persisted Task history");
});

test("a multi-step resumed chain keeps only the latest selectable card in transcript order", () => {
  const original = item("original", "explorer");
  const middle = item("middle", "explorer");
  middle.message.toolArgs.resume = "delegate-original";
  const latest = item("latest", "explorer");
  latest.message.toolArgs.resume = "delegate-middle";
  const items = [original, item("peer", "explorer"), middle, item("custom", "project-reviewer"), latest];
  const before = structuredClone(items);
  const html = render(items);
  assert.deepEqual(messageIds(html), ["peer", "custom", "latest"]);
  assert.deepEqual(agentNames(html), ["explorer", "project-reviewer", "explorer"]);
  assert.match(html, />Coordinating 3 delegated tasks<\/span>/);
  assert.deepEqual(items, before, "resume selection must not discard historical Task rows");
});

test("actual delegate attribution, steps, lifecycle outcomes and timings reach their cards", () => {
  const actual = item("actual", "explorer");
  actual.delegate = { agentName: "Project Reviewer", items: [{ kind: "answer", message: { id: "answer", role: "assistant", content: "Report" } }] };
  const html = render([actual], {
    delegationStatuses: new Map([["delegate-actual", "failed"]]),
    delegationTimings: new Map([["delegate-actual", { startedAt: 1000, completedAt: 4250 }]]),
  });
  assert.deepEqual(messageIds(html), ["actual"]);
  assert.deepEqual(agentNames(html), ["Project Reviewer"]);
  assert.match(html, /outcome-failed/);
  assert.match(html, /Failed · 3s<\/span>/);
  assert.match(html, />1 step<\/span>/);
  assert.doesNotMatch(html, /<img\b|subagent-topology-idle/);
});

test("an empty topology never fabricates idle specialists", () => {
  const html = render([]);
  assert.deepEqual(messageIds(html), []);
  assert.deepEqual(agentNames(html), []);
  assert.doesNotMatch(html, /role="listitem"|<img\b|subagent-topology-idle/);
});
