import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import test from "node:test";
import ts from "typescript";
import { IPC, IPC_WHITELIST, OAUTH_AUTH_KIND } from "@pi-desktop/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { registerConductorIpc } = await import("../electron/main/ipc/conductor-ipc.ts");
const { conductorQualityCatalog } = await import("../electron/main/conductor/quality.ts");
const entry = () => ({ sessionId: "owned-session", requestId: "12345678-1234-1234-1234-123456789012", objective: "Inspect owned fixture", purpose: "analysis",
  scope: ["fixture.txt"], allowedPaths: [], excludedPaths: [], acceptanceCriteria: ["Use observed source"], materialPaths: ["fixture.txt"], qualityCommandIds: [] });
const history = { index: { runId: "CON-2026-1234", sessionId: "owned-session", projectPath: "owned-repo", version: 1, status: "running" }, checkpoint: {}, intake: {}, resourceIssues: [] };
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function harness({ resolveProvider, sidecarCall, hostCall } = {}) {
  const handlers = new Map(), calls = [], bindings = [], turns = new Map();
  const frame = {}, window = { isDestroyed: () => false, webContents: { id: 71, mainFrame: frame } };
  const event = { sender: { id: 71 }, senderFrame: frame };
  const owner = { id: "owned-session", projectPath: "owned-repo", providerId: "fixture", modelId: "fixture-model", thinkingLevel: "off" };
  const provider = { id: "fixture", name: "Fixture", modelId: "fixture-model", apiKey: "owned-fixture-only", authKind: "api-key" };
  let providerCalls = 0, releases = 0;
  const sidecar = { setVendorAuthBindings: (...args) => bindings.push(args), call: async (method, input) => {
    calls.push([method, input]);
    if (sidecarCall) return sidecarCall(method, input);
    if (method === "conductor.availability") return { available: true, provenance: {} };
    if (method === "conductor.start" || method === "conductor.history" || method === "conductor.cancel") return history;
    if (method === "conductor.list") return { runs: [history.index] };
    if (method === "conductor.authorize") return { acknowledged: true };
    assert.fail(`Unexpected sidecar ${method}`);
  } };
  const host = { call: async (method, input) => {
    calls.push([method, input]);
    if (hostCall) return hostCall(method, input, owner);
    if (method === "session.get") return { session: { ...owner } };
    if (method === "settings.get") return {};
    if (method === "session.getScratchPath") return { path: "owned-scratch" };
    assert.fail(`Unexpected host ${method}`);
  } };
  registerConductorIpc({ registrar: {
    handleWithEvent: (channel, handler) => handlers.set(channel, handler),
    assertMainWindowSender: ev => { if (ev.sender.id !== 71) throw new Error("PERMISSION_DENIED"); },
  }, getMainWindow: () => window, getHost: () => host, getSidecar: () => sidecar, activeTurns: turns,
  acquireSessionOperation: async () => () => { releases++; },
  resolveRuntimeProvider: async (...args) => { providerCalls++; return resolveProvider ? resolveProvider(...args) : { provider, runtimeProvider: provider, thinkingLevel: "off" }; },
  });
  return { calls, bindings, owner, provider, turns, event, window, sidecar,
    providerCalls: () => providerCalls, releases: () => releases,
    invoke: (channel, input, ev = event) => handlers.get(channel)(ev, input) };
}
function load(relative, imports, globals = {}) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: file.pathname });
  const module = { exports: {} };
  new Function("require", "exports", "module", ...Object.keys(globals), outputText)(id => { assert.ok(Object.hasOwn(imports, id), `Unexpected dependency ${id}`); return imports[id]; }, module.exports, module, ...Object.values(globals));
  return module.exports;
}
function renderer(h) {
  let bridge; const listeners = new Map();
  const ipcRenderer = { invoke: async (channel, input) => ({ ok: true, data: await h.invoke(channel, input) }),
    on: (channel, callback) => listeners.set(channel, callback), removeListener: (channel, callback) => { assert.equal(listeners.get(channel), callback); listeners.delete(channel); } };
  load("../electron/preload/index.ts", { electron: { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer, webUtils: {} }, "@pi-desktop/shared/protocol": { IPC, IPC_WHITELIST } });
  const { api } = load("../src/lib/api.ts", { "@pi-desktop/shared": { IPC } }, { window: { piDesktop: bridge } });
  return { api, bridge, listeners };
}

test("API → real preload → guarded main keeps owner repo and launch authority separate", async () => {
  const h = harness(), { api, bridge, listeners } = renderer(h);
  assert.deepEqual(await api.conductorStart(entry()), history);
  const start = h.calls.find(([method]) => method === "conductor.start")[1];
  assert.equal(start.request.projectPath, "owned-repo");
  assert.equal(start.request.qualityCommandIds, undefined);
  assert.ok(!Object.hasOwn(start.request, "qualityCommandIds"));
  assert.deepEqual(start.request.qualityCommands, []);
  assert.equal(start.launch.provider.apiKey, "owned-fixture-only");
  assert.deepEqual(h.bindings, [["owned-session", []]]);
  assert.equal(h.releases(), 1);
  assert.ok(!h.calls.some(([method]) => method === "agent.prompt" || method.startsWith("tools.")));
  let observed; const off = bridge.on(IPC.event.conductorChanged, value => { observed = value; });
  listeners.get(IPC.event.conductorChanged)({}, { sessionId: "owned-session", runId: "CON-2026-1234" });
  assert.deepEqual(observed, { sessionId: "owned-session", runId: "CON-2026-1234" });
  off(); assert.equal(listeners.size, 0);
  await assert.rejects(bridge.invoke("pi-desktop/conductorStore/append", {}), /not allowed/);
});
test("untrusted sender, subframe and destroyed window fail before backend effects", async () => {
  const h = harness();
  for (const event of [{ sender: { id: 99 }, senderFrame: h.event.senderFrame }, { sender: { id: 71 }, senderFrame: {} }, { sender: { id: 71 } }]) {
    await assert.rejects(h.invoke(IPC.invoke.conductorStart, entry(), event), /PERMISSION_DENIED/);
  }
  h.window.isDestroyed = () => true;
  await assert.rejects(h.invoke(IPC.invoke.conductorAvailability, {}), /PERMISSION_DENIED/);
  assert.deepEqual(h.calls, []); assert.equal(h.providerCalls(), 0);
});
test("renderer launch injection and invalid mandates fail before host or credentials", async () => {
  const h = harness();
  for (const patch of [{ launch: {} }, { projectPath: "foreign" }, { provider: {} }, { qualityCommands: [] }, { scope: ["../foreign"] }, { allowedPaths: ["fixture.txt"] }, { scope: ["fixture.txt", "fixture.txt"] }, { purpose: "implementation" }, { requestId: "invented" }]) {
    await assert.rejects(h.invoke(IPC.invoke.conductorStart, { ...entry(), ...patch }), /CONDUCTOR_INPUT_/);
  }
  assert.deepEqual(h.calls, []); assert.equal(h.providerCalls(), 0);
});
test("unavailable engine blocks before owner, credentials or generic chat fallback", async () => {
  const h = harness({ sidecarCall: async () => ({ available: false, code: "CONDUCTOR_ENGINE_UNAVAILABLE" }) });
  await assert.rejects(h.invoke(IPC.invoke.conductorStart, entry()), /CONDUCTOR_ENGINE_UNAVAILABLE/);
  assert.equal(h.providerCalls(), 0); assert.deepEqual(h.calls.map(([method]) => method), ["conductor.availability"]);
});
test("history and catalog reads do not resolve provider, scratch or Docker", async () => {
  const h = harness(), { api } = renderer(h);
  await api.conductorList("owned-session"); await api.conductorHistory({ sessionId: "owned-session", runId: "CON-2026-1234" });
  assert.deepEqual(await api.conductorCatalog(), { commands: conductorQualityCatalog() });
  assert.equal(h.providerCalls(), 0); assert.deepEqual(h.calls.map(([method]) => method), ["conductor.list", "conductor.history"]);
});
test("project change during provider preparation cannot start against stale owner", async () => {
  const h = harness({ resolveProvider: async () => { h.owner.projectPath = "changed-repo"; return { provider: h.provider, runtimeProvider: h.provider, thinkingLevel: "off" }; } });
  await assert.rejects(h.invoke(IPC.invoke.conductorStart, entry()), /CONDUCTOR_OWNER_PROJECT_CHANGED/);
  assert.ok(!h.calls.some(([method]) => method === "conductor.start")); assert.equal(h.releases(), 1);
});
test("only the chosen OAuth account is bound and no key crosses this main response", async () => {
  const h = harness(); h.provider.authKind = OAUTH_AUTH_KIND; h.provider.apiKey = "";
  assert.deepEqual(await h.invoke(IPC.invoke.conductorStart, entry()), history);
  assert.deepEqual(h.bindings, [["owned-session", [{ providerId: "fixture" }]]]);
});
test("main preparation cancellation waits for settlement and prevents provider or start", async () => {
  const held = deferred(), seen = deferred();
  const h = harness({ sidecarCall: async method => { assert.equal(method, "conductor.availability"); seen.resolve(); await held.promise; return { available: true }; } });
  const start = h.invoke(IPC.invoke.conductorStart, entry()); const rejected = assert.rejects(start, /CONDUCTOR_CANCELLED/);
  await seen.promise;
  await assert.rejects(h.invoke(IPC.invoke.conductorStart, entry()), /CONDUCTOR_SESSION_BUSY/);
  let settled = false; const cancelled = h.invoke(IPC.invoke.conductorCancelAdmission, { sessionId: "owned-session", requestId: entry().requestId }).then(() => { settled = true; });
  assert.equal(settled, false); held.resolve(); await cancelled; await rejected;
  assert.equal(h.providerCalls(), 0); assert.equal(h.releases(), 1);
});
test("main forwards admission cancellation to release an actual pending boundary", async () => {
  const held = deferred(), seen = deferred();
  const h = harness({ sidecarCall: async method => {
    if (method === "conductor.availability") return { available: true };
    if (method === "conductor.start") { seen.resolve(); await held.promise; throw new Error("CONDUCTOR_CANCELLED"); }
    if (method === "conductor.cancelAdmission") { held.resolve(); return { cancelled: true }; }
    assert.fail(method);
  } });
  const rejected = assert.rejects(h.invoke(IPC.invoke.conductorStart, entry()), /CONDUCTOR_CANCELLED/); await seen.promise;
  assert.deepEqual(await h.invoke(IPC.invoke.conductorCancelAdmission, { sessionId: "owned-session", requestId: entry().requestId }), { cancelled: true });
  await rejected; assert.equal(h.releases(), 1);
});
test("lost start response cleans only the matching owner/request run before returning timeout", async () => {
  const cancelled = [];
  const h = harness({ sidecarCall: async (method, input) => {
    if (method === "conductor.availability") return { available: true };
    if (method === "conductor.start") throw new Error("sidecar RPC timeout: conductor.start");
    if (method === "conductor.cancelAdmission") throw new Error("CONDUCTOR_ADMISSION_STALE");
    if (method === "conductor.list") return { runs: [
      { ...history.index, requestId: entry().requestId },
      { ...history.index, runId: "CON-2026-9999", requestId: "other-request" },
      { ...history.index, runId: "CON-2026-9998", sessionId: "other-owner", requestId: entry().requestId },
    ] };
    if (method === "conductor.cancel") { cancelled.push(input); return history; }
    assert.fail(method);
  } });
  await assert.rejects(h.invoke(IPC.invoke.conductorStart, entry()), /sidecar RPC timeout/);
  assert.deepEqual(cancelled, [{ sessionId: "owned-session", runId: "CON-2026-1234" }]);
  assert.equal(h.releases(), 1);
});
test("ordinary duplicate-start refusal does not cancel an existing run", async () => {
  const h = harness({ sidecarCall: async method => {
    if (method === "conductor.availability") return { available: true };
    if (method === "conductor.start") throw new Error("CONDUCTOR_REQUEST_EXISTS");
    assert.fail(`Ordinary refusal must not trigger cleanup: ${method}`);
  } });
  await assert.rejects(h.invoke(IPC.invoke.conductorStart, entry()), /CONDUCTOR_REQUEST_EXISTS/);
  assert.equal(h.releases(), 1);
});
test("uncertain start cleanup stays observable instead of reporting a clean timeout", async () => {
  const h = harness({ sidecarCall: async method => {
    if (method === "conductor.availability") return { available: true };
    if (method === "conductor.start") throw new Error("sidecar RPC timeout: conductor.start");
    if (method === "conductor.cancelAdmission") throw new Error("owned cleanup acknowledgement failed");
    assert.fail(method);
  } });
  await assert.rejects(h.invoke(IPC.invoke.conductorStart, entry()), { errorCode: "CONDUCTOR_RECOVERY_FAILED" });
  assert.equal(h.releases(), 1);
});
