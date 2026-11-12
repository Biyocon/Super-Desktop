import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { IPC } from "@pi-desktop/shared";
const require = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url));
const { build } = require("esbuild");
const compiled = await build({ entryPoints: [fileURLToPath(new URL("../src/features/conductor/history-controller.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", packages: "external", logLevel: "silent" });
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(require, module, module.exports);
const { ConductorHistoryController } = module.exports;
const { api } = await import("../src/lib/api.ts");
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const runId = "CON-2026-0001", otherRun = "CON-2026-0002";
function saved(id = runId, version = 1, status = "completed") {
  return { index: { schema: 1, sessionId: "owner", runId: id, projectPath: "/fixture", version, eventCount: 0, status, checkpointHash: String(version), runtimeId: "runtime" }, checkpoint: {}, intake: {}, resourceIssues: [], pendingConsent: null };
}
function fixture(t) {
  const calls = [], listeners = new Map(), handlers = new Map();
  let records = [saved()];
  globalThis.window = { piDesktop: {
    invoke: async (channel, input) => {
      calls.push({ channel, input });
      if (handlers.has(channel)) return handlers.get(channel)(input);
      const data = channel === IPC.invoke.conductorAvailability ? { available: true, provenance: {} }
        : channel === IPC.invoke.conductorCatalog ? { commands: [] }
        : channel === IPC.invoke.conductorList ? { runs: records.map(record => record.index) }
        : channel === IPC.invoke.conductorHistory ? structuredClone(records.find(record => record.index.runId === input.runId))
        : channel === IPC.invoke.conductorStart ? structuredClone(records[0]) : { acknowledged: true };
      return { ok: true, data };
    },
    on(channel, listener) { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); return () => set.delete(listener); },
  } };
  // Real public API invokes the actual preload boundary fixture.
  const client = {
    availability: api.conductorAvailability, catalog: api.conductorCatalog, list: api.conductorList, history: api.conductorHistory,
    start: api.conductorStart, resume: api.conductorResume, cancel: api.conductorCancel,
    cancelAdmission: api.conductorCancelAdmission, authorize: api.conductorAuthorize,
    onChanged: listener => window.piDesktop.on(IPC.event.conductorChanged, listener),
    onFault: listener => window.piDesktop.on(IPC.event.conductorFault, listener),
  };
  const controller = new ConductorHistoryController("owner", client), disconnect = controller.connect();
  t.after(disconnect);
  const until = async predicate => {
    if (predicate()) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("Controller did not reach expected state")); }, 1000);
      const unsubscribe = controller.subscribe(() => { if (predicate()) { clearTimeout(timer); unsubscribe(); resolve(); } });
    });
  };
  return { controller, calls, listeners, handlers, disconnect, until,
    records: value => { records = value; },
    emit: event => { for (const listener of listeners.get(IPC.event.conductorChanged) ?? []) listener(event); },
  };
}
const draft = { objective: "Review fixture", purpose: "analysis", scope: ["fixture.txt"], allowedPaths: [], excludedPaths: [], acceptanceCriteria: ["Evidence cited"], materialPaths: [], qualityCommandIds: [] };

test("opening, duplicate invalidations and reopening read history without dispatch or replay", async t => {
  const f = fixture(t); await f.until(() => !!f.controller.snapshot().history && !f.controller.snapshot().loading);
  const mutations = () => f.calls.filter(call => [IPC.invoke.conductorStart, IPC.invoke.conductorResume, IPC.invoke.conductorAuthorize, IPC.invoke.conductorCancel].includes(call.channel));
  for (let n = 0; n < 10; n++) f.emit({ sessionId: "owner", runId });
  await f.controller.refresh(); assert.equal(mutations().length, 0);
  f.disconnect(); for (const entries of f.listeners.values()) assert.equal(entries.size, 0);
  const close = f.controller.connect(); await f.controller.refresh(); close();
  assert.equal(mutations().length, 0);
});

test("late history for previous selection and stale versions cannot replace the current run", async t => {
  const f = fixture(t); await f.until(() => !!f.controller.snapshot().history && !f.controller.snapshot().loading);
  f.records([saved(runId, 5), saved(otherRun, 2)]);
  const late = deferred(), entered = deferred(); let held = false;
  f.handlers.set(IPC.invoke.conductorHistory, input => {
    if (input.runId === runId && !held) { held = true; entered.resolve(); return late.promise; }
    return { ok: true, data: saved(input.runId, input.runId === runId ? 5 : 2) };
  });
  const refresh = f.controller.refresh(); await entered.promise;
  f.controller.select(otherRun); late.resolve({ ok: true, data: saved(runId, 5) }); await refresh;
  await f.until(() => f.controller.snapshot().history?.index.runId === otherRun);
  assert.equal(f.controller.snapshot().history.index.version, 2);
  f.handlers.set(IPC.invoke.conductorHistory, () => ({ ok: true, data: saved(otherRun, 1, "running") }));
  await f.controller.refresh(); assert.equal(f.controller.snapshot().history.index.version, 2);
  assert.equal(f.controller.snapshot().history.index.status, "completed");
});

test("double start is fenced, exact pending admission can be cancelled, and initial receipt is reloaded", async t => {
  const f = fixture(t); await f.until(() => !!f.controller.snapshot().history && !f.controller.snapshot().loading);
  const start = deferred(); f.handlers.set(IPC.invoke.conductorStart, () => start.promise);
  const first = f.controller.start(draft), second = f.controller.start(draft);
  const requestId = f.controller.snapshot().admissionRequest;
  assert.match(requestId, /^[a-f0-9-]{36}$/);
  await f.controller.cancelAdmission();
  assert.deepEqual(f.calls.find(call => call.channel === IPC.invoke.conductorCancelAdmission).input, { sessionId: "owner", requestId });
  f.records([saved(runId, 2)]); start.resolve({ ok: true, data: saved(runId, 2) }); await Promise.all([first, second]);
  assert.equal(f.calls.filter(call => call.channel === IPC.invoke.conductorStart).length, 1);
  assert.equal(f.controller.snapshot().history.index.version, 2);
  assert.equal(f.controller.snapshot().admissionRequest, null);
});

test("consent sends only exact pending identity and never optimistically changes a gate", async t => {
  const f = fixture(t);
  const request = { sessionId: "owner", runId, requestId: crypto.randomUUID(), baselineHash: "a".repeat(64), sourceFingerprint: "b".repeat(64), baseline: {}, effectProfile: {} };
  f.records([{ ...saved(runId, 3, "owner-waiting"), pendingConsent: request }]);
  await f.until(() => !!f.controller.snapshot().history && !f.controller.snapshot().loading);
  await f.controller.authorize({ ...request, requestId: crypto.randomUUID() }, true);
  assert.equal(f.calls.filter(call => call.channel === IPC.invoke.conductorAuthorize).length, 0);
  const ack = deferred(); f.handlers.set(IPC.invoke.conductorAuthorize, () => ack.promise);
  const answer = f.controller.authorize(request, true);
  assert.equal(f.controller.snapshot().history.index.status, "owner-waiting");
  assert.deepEqual(f.calls.find(call => call.channel === IPC.invoke.conductorAuthorize).input, { sessionId: "owner", runId, requestId: request.requestId, baselineHash: request.baselineHash, approve: true });
  ack.resolve({ ok: true, data: { acknowledged: true } }); await answer;
  assert.equal(f.controller.snapshot().history.index.status, "owner-waiting", "only actual history can update lifecycle");
});

test("foreign invalidations and post-disposal replies do not mutate the panel", async t => {
  const f = fixture(t); await f.until(() => !!f.controller.snapshot().history && !f.controller.snapshot().loading);
  const count = f.calls.length; f.emit({ sessionId: "other", runId }); assert.equal(f.calls.length, count);
  const late = deferred(); f.handlers.set(IPC.invoke.conductorList, () => late.promise);
  const pending = f.controller.refresh(), before = f.controller.snapshot(); f.disconnect();
  late.resolve({ ok: true, data: { runs: [saved(runId, 100).index] } }); await pending;
  assert.equal(f.controller.snapshot(), before);
});

test("effect reconnect while an old read is in flight still loads the new generation", async t => {
  const f = fixture(t); await f.until(() => !!f.controller.snapshot().history && !f.controller.snapshot().loading);
  const late = deferred(); f.handlers.set(IPC.invoke.conductorList, () => late.promise);
  const pending = f.controller.refresh(); f.disconnect(); f.handlers.delete(IPC.invoke.conductorList); f.records([saved(runId, 9)]);
  const close = f.controller.connect(); t.after(close);
  await Promise.resolve(); await Promise.resolve();
  late.resolve({ ok: true, data: { runs: [saved().index] } }); await pending;
  await f.until(() => f.controller.snapshot().history?.index.version === 9 && !f.controller.snapshot().loading);
});
