import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import * as shared from "@pi-desktop/shared";
import * as catalog from "@pi-desktop/i18n";
const require = createRequire(new URL("../package.json", import.meta.url));
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
await i18n.init({ lng: "en", resources: { en: { translation: {} } }, react: { useSuspense: false } });
function item(id, agent = "explorer") {
  return { kind: "tool", message: { id, toolCallId: id, role: "tool", content: "", createdAt: "2026-11-10T00:00:00.000Z", toolName: "Task", toolStatus: "success", toolArgs: { agent, task: id, description: id }, toolResult: { details: { delegationId: `delegate-${id}`, status: "completed" } } } };
}
function render(items) {
  return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(SubagentTopology, { items })));
}

test("two independent tasks for one role render two distinct selectable completed cards", () => {
  const html = render([item("first"), item("second")]);
  assert.match(html, /data-message-id="first"/);
  assert.match(html, /data-message-id="second"/);
  assert.equal((html.match(/class="subagent-topology-node-header"/g) ?? []).length, 2);
  assert.equal((html.match(/subagent-topology-idle/g) ?? []).length, 6);
  assert.match(html, /subagent-topology-root/);
});

test("unused canonical roles retain their placeholders and unknown actual tasks are not dropped", () => {
  const html = render([item("custom", "project-reviewer")]);
  assert.match(html, /data-message-id="custom"/);
  assert.equal((html.match(/subagent-topology-idle/g) ?? []).length, 7);
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
  assert.equal((html.match(/subagent-topology-idle/g) ?? []).length, 7);
});
