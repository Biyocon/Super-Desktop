import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { act, createElement as h } from "react";
import { createInstance } from "i18next";
import * as shared from "@pi-desktop/shared";
import { installBrowser, descendants } from "./helpers/react-dom-host.mjs";
const require = createRequire(new URL("../package.json", import.meta.url));
const { I18nextProvider } = require("react-i18next");
const runtimeRequire = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url));
const compiled = await runtimeRequire("esbuild").build({ stdin: {
  contents: 'export { ConductorPanel } from "./ConductorPanel"; export { ConductorRunView } from "./ConductorRunView"; export { entryLines } from "./ConductorEntryForm";',
  resolveDir: fileURLToPath(new URL("../src/features/conductor/", import.meta.url)), loader: "tsx",
}, bundle: true, write: false, platform: "node", format: "cjs", packages: "external", jsx: "automatic", loader: { ".css": "empty", ".png": "dataurl" }, logLevel: "silent" });
installBrowser();
const { createRoot } = require("react-dom/client");
const runId = "CON-2026-0001";
const request = { sessionId: "owner", runId, requestId: crypto.randomUUID(), baselineHash: "a".repeat(64), sourceFingerprint: "b".repeat(64),
  baseline: { scopeVersion: "scope-v1", planVersion: "plan-v2", acceptanceVersion: "criteria-v3", allowedPaths: ["fixture.txt"], excludedPaths: ["private"], rollbackReference: "rollback-123", qualityCommands: [{ id: "node-tests", definitionHash: "d".repeat(64), requiredGates: ["D", "E"] }] },
  effectProfile: { filesystem: "workspace-write", quality: "catalog", external: "none" } };
const history = () => ({ index: { runId, sessionId: "owner", projectPath: "/owned/repo", version: 4, status: "owner-waiting", checkpointHash: "c".repeat(64) }, resourceIssues: [], pendingConsent: null, checkpoint: { recordFormatVersion: 5 }, intake: {}, projection: {
  recordFormat: 5, purpose: "analysis", objective: "Review bounded fixture", motorStatus: "reported", currentStage: "report-complete", authorityOwner: "owner", sourceBaseline: "source-hash", next: "none", scope: ["fixture.txt"], allowedPaths: [], excludedPaths: [], acceptanceCriteria: ["Evidence required"], constraints: [], diagnostics: [],
  workers: [1, 2].map(n => ({ dispatchId: `dispatch-${n}`, workerId: "same-worker", stage: "detective", mode: "producer", task: `Task number ${n}`, startVersion: n, inputHash: `input-${n}`, status: "completed", output: `Gate pass (untrusted worker ${n})` })),
  gateHistory: [{ index: 0, gate: "A", stage: "detective", kind: "evaluated", decision: "rework", basis: ["Missing source evidence"], evidenceReviewed: ["report-v1"], stateUpdate: "Invalidate downstream plan and challenge", nextStage: "detective", defectClass: "design" },
    { index: 1, gate: "B", stage: "strategist", kind: "skipped", decision: "skipped", basis: ["Read-only answer requires no implementation plan"], evidenceReviewed: [], stateUpdate: "Not applicable" }],
  reports: [{ id: "decision-1", stage: "arbiter", kind: "decision", body: '{"decision":"no-go","basis":["Missing evidence"]}' }],
} });
const session = { id: "owner", title: "Owned chat", source: "desktop", projectPath: "/owned/repo" };
function load() { const module = { exports: {} }; new Function("require", "module", "exports", compiled.outputFiles[0].text)(id => id === "@pi-desktop/shared" ? shared : require(id), module, module.exports); return module.exports; }
function button(container, text) { const node = descendants(container).find(node => node.tagName === "BUTTON" && node.textContent.includes(text)); assert.ok(node, `Missing button ${text}`); return node; }
async function fixture(t) {
  const env = installBrowser();
  env.window.setInterval = globalThis.setInterval; env.window.clearInterval = globalThis.clearInterval;
  Object.defineProperty(env.window.HTMLElement.prototype, "options", { configurable: true, get() { return descendants(this).filter(node => node.tagName === "OPTION"); } });
  const calls = [], handlers = new Map(), listeners = new Map(); let saved = history();
  env.window.piDesktop = { invoke: async (channel, input) => {
    calls.push({ channel, input }); if (handlers.has(channel)) return handlers.get(channel)(input);
    const data = channel === shared.IPC.invoke.conductorAvailability ? { available: true, provenance: { revision: "879ab27", version: "0.1.0-rc.7", license: "MIT", recordFormat: 5, artifacts: {} } }
      : channel === shared.IPC.invoke.conductorCatalog ? { commands: [{ id: "node-tests", image: "sha256:owned", argv: ["node", "--test"], requiredGates: ["D", "E"] }] }
      : channel === shared.IPC.invoke.conductorList ? { runs: [saved.index] }
      : channel === shared.IPC.invoke.conductorHistory ? structuredClone(saved) : { acknowledged: true };
    return { ok: true, data };
  }, on(channel, listener) { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); return () => set.delete(listener); } };
  const i18n = createInstance(); await i18n.init({ lng: "en", fallbackLng: false, resources: { en: { translation: {} } }, react: { useSuspense: false } });
  const container = env.document.createElement("div"); env.document.body.appendChild(container); const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); });
  return { ...load(), container, calls, handlers, listeners,
    saved: value => { saved = value; },
    render: async element => { await act(async () => root.render(h(I18nextProvider, { i18n }, element))); },
    click: async text => { await act(async () => button(container, text).click()); },
    emit: async () => { await act(async () => { for (const listener of listeners.get(shared.IPC.event.conductorChanged) ?? []) listener({ sessionId: "owner", runId }); }); },
  };
}

test("dedicated panel opens real saved history, separates authority and never dispatches on reopen", async t => {
  const f = await fixture(t); await f.render(h(f.ConductorPanel, { session })); assert.equal(f.calls.length, 0, "closed ordinary chat does not load the engine");
  await f.click("conductor.open"); assert.ok(f.container.textContent.includes(runId));
  assert.ok(f.container.textContent.includes("conductor.emperor")); assert.ok(f.container.textContent.includes("conductor.roles.conductor"));
  await f.click("conductor.specialistRoles");
  const portraits = descendants(f.container).filter(node => node.tagName === "IMG").map(node => node.getAttribute("data-conductor-role"));
  for (const role of ["conductor", "detective", "strategist", "devils-advocate", "headsman", "auditor", "integrator", "arbiter"]) assert.ok(portraits.includes(role));
  assert.ok(!f.container.textContent.includes("conductor.roles.ralph"), "Ralph not invented");
  const workers = descendants(f.container).filter(node => node.getAttribute?.("class") === "panel-card"); assert.equal(workers.length, 2);
  await f.click("dispatch-1"); assert.ok(f.container.textContent.includes("Gate pass (untrusted worker 1)")); assert.ok(!f.container.textContent.includes("Gate pass (untrusted worker 2)"));
  await f.click("dispatch-2"); assert.ok(f.container.textContent.includes("Task number 1")); assert.ok(f.container.textContent.includes("Task number 2"));
  await f.click("conductor.close"); for (const set of f.listeners.values()) assert.equal(set.size, 0);
  await f.click("conductor.open"); assert.ok(f.container.textContent.includes(runId));
  assert.equal(f.calls.filter(call => [shared.IPC.invoke.conductorStart, shared.IPC.invoke.conductorResume].includes(call.channel)).length, 0);
});

test("gate and decision disclosures use exact matching evidence, not worker prose", async t => {
  const f = await fixture(t), record = history();
  record.projection.arbiterDecision = { purpose: "implementation", outcome: "no-go", basis: ["Missing evidence"], evidenceReviewed: ["report-v1"] };
  await f.render(h(f.ConductorRunView, { history: record, busy: false, engineAvailable: true, onResume() {}, onCancel() {}, onAnswer() {} }));
  assert.ok(f.container.textContent.includes("NO-GO"));
  const rework = button(f.container, "rework"); assert.equal(rework.getAttribute("aria-expanded"), "false");
  await act(async () => rework.click()); assert.equal(rework.getAttribute("aria-expanded"), "true");
  assert.ok(f.container.textContent.includes("Missing source evidence")); assert.ok(f.container.textContent.includes("Invalidate downstream plan and challenge"));
  await f.click("skipped"); assert.ok(f.container.textContent.includes("Read-only answer requires no implementation plan"));
  await f.click("decision-1"); assert.ok(f.container.textContent.includes('"decision":"no-go"'));
  assert.ok(!f.container.textContent.includes("conductor.statuses.pass"));
});

test("Gate-C panel shows exact source, versions, scope and effect profile and answers that snapshot", async t => {
  const f = await fixture(t); const answers = [];
  await f.render(h(f.ConductorRunView, { history: { ...history(), pendingConsent: request }, busy: false, engineAvailable: true, onResume() {}, onCancel() {}, onAnswer: (...args) => answers.push(args) }));
  for (const text of [request.requestId, request.baselineHash, request.sourceFingerprint, "scope-v1", "plan-v2", "criteria-v3", "fixture.txt", "private", "rollback-123", "workspace-write", "node-tests"]) assert.ok(f.container.textContent.includes(text), text);
  await f.click("conductor.approve"); assert.deepEqual(answers, [[request, true]]);
  await f.click("conductor.deny"); assert.deepEqual(answers.at(-1), [request, false]);
  await f.render(h(f.ConductorRunView, { history: { ...history(), pendingConsent: request }, busy: true, engineAvailable: true, onResume() {}, onCancel() {}, onAnswer() { throw new Error("Busy answer"); } }));
  assert.equal(button(f.container, "conductor.approve").disabled, true);
});

test("missing engine visibly blocks entry without hiding saved history or invoking fallback", async t => {
  const f = await fixture(t); f.handlers.set(shared.IPC.invoke.conductorAvailability, () => ({ ok: true, data: { available: false, code: "CONDUCTOR_ENGINE_UNAVAILABLE" } }));
  await f.render(h(f.ConductorPanel, { session })); await f.click("conductor.open"); await f.click("conductor.newRun");
  assert.ok(f.container.textContent.includes("conductor.unavailable")); assert.ok(f.container.textContent.includes(runId));
  assert.equal(button(f.container, "conductor.start").disabled, true);
  assert.equal(f.calls.filter(call => call.channel === shared.IPC.invoke.agentPrompt || call.channel === shared.IPC.invoke.conductorStart).length, 0);
});

test("new entry switches purpose explicitly and analysis has no write or quality mandate", async t => {
  const f = await fixture(t); const completed = history(); completed.index.status = "completed"; f.saved(completed);
  await f.render(h(f.ConductorPanel, { session })); await f.click("conductor.open"); await f.click("conductor.newRun");
  assert.ok(!f.container.textContent.includes("conductor.allowedPaths"));
  await f.click("conductor.implementation"); assert.ok(f.container.textContent.includes("conductor.allowedPaths")); assert.ok(f.container.textContent.includes("node-tests"));
  await f.click("conductor.analysis"); assert.ok(!descendants(f.container).some(node => node.getAttribute?.("name") === "allowedPaths"));
  assert.deepEqual(f.entryLines(" fixture.txt\r\n\n docs/readme.md \n"), ["fixture.txt", "docs/readme.md"]);
});

test("chat surface exposes one session-keyed entry before empty/transcript branching", async () => {
  const surface = await readFile(new URL("../src/components/ChatSurface.tsx", import.meta.url), "utf8");
  const pane = await readFile(new URL("../src/components/SessionPane.tsx", import.meta.url), "utf8");
  assert.match(surface, /visible && activeSession && !sessionSwitching && <ConductorPanel key=\{activeSession\.id\} session=\{activeSession\}/);
  assert.ok(surface.indexOf("<ConductorPanel") < surface.indexOf("{showEmptyState ?"), "new empty chats must not require an ordinary model message first");
  assert.doesNotMatch(pane, /ConductorPanel/, "retained hidden panes must not duplicate the process surface");
});
