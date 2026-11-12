// Fixture-only API-chain acceptance, NOT native Electron/UI or live-model acceptance.
// Run from the request worktree with already-built host/shared/runtime/bundle:
// node packages/conductor-runtime/test/desktop-api.acceptance.mjs <absolute-hostBinary> <absolute-docker> <cachedImage> <absolute-owned-scratch>
// Only Electron IPC/contextBridge and external provider/metadata/owner answers are fixtures.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire, register } from "node:module";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const [hostBinary, docker, cachedImage, scratch, ...extra] = process.argv.slice(2);
const pinnedImage = "sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0";
assert.ok(hostBinary && docker && scratch && !extra.length, "Explicit hostBinary, docker, cachedImage and owned scratch required");
for (const path of [hostBinary, docker, scratch]) assert.ok(isAbsolute(path), "Paths must be absolute");
assert.equal(cachedImage, pinnedImage, "Use the main-process node-tests catalog's already-cached image; never inject argv/image");
for (const path of [hostBinary, docker]) {
  const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Use explicit regular binaries");
}
const root = await mkdtemp(join(resolve(scratch), "conductor-desktop-api-"));
const home = join(root, "home"), repo = join(root, "repo"), data = join(root, "data");
const resultPath = join(resolve(scratch), "conductor-desktop-api-result.json");
const originalEnv = { ...process.env }, originalCwd = process.cwd();
const calls = [], providerCalls = [], outcomes = [], faults = [], permissionRequests = [];
const ownedSessions = new Set();
const result = { fixtureOnly: true, nativeElectronAccepted: false, liveModelAccepted: false, passed: false,
  chain: "renderer API -> preload -> registerConductorIpc -> resolveRuntimeProvider -> HostProcess/AgentSidecar -> unchanged Harness -> Rust persistence",
  calls, providerCalls, outcomes, faults, provenance: null };
let host, sidecar, restoreNetwork, server, failure;
const text = content => typeof content === "string" ? content : (content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
const sha256 = value => createHash("sha256").update(value).digest("hex");

// Installed in this process AND the packaged child before importing runtime code.
// No inherited credentials, NODE_OPTIONS, proxy configuration or user profiles.
async function installNetworkGuard(origin) {
  const net = await import("node:net");
  const { syncBuiltinESMExports } = await import("node:module");
  const allowed = new URL(origin), originalFetch = globalThis.fetch;
  const connect = net.Socket.prototype.connect;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== origin) throw new Error("Non-fixture fetch denied");
    return originalFetch(input, { ...init, redirect: "error" });
  };
  net.Socket.prototype.connect = function (...args) {
    const values = Array.isArray(args[0]) ? args[0] : args;
    const first = values[0];
    const options = first && typeof first === "object" ? first : { port: first, host: typeof values[1] === "string" ? values[1] : "localhost" };
    if (options.path || options.host !== "127.0.0.1" || String(options.port) !== allowed.port) throw new Error("Non-fixture socket denied");
    return Reflect.apply(connect, this, args);
  };
  syncBuiltinESMExports();
  return () => { globalThis.fetch = originalFetch; net.Socket.prototype.connect = connect; syncBuiltinESMExports(); };
}
function observe(transport, boundary) {
  const call = transport.call.bind(transport);
  // Observation only: every request and error still uses the real transport.
  transport.call = (method, ...args) => {
    const input = args[0];
    calls.push({ boundary, method, ...(method === "tools.execute" ? { sessionId: input.sessionId, toolName: input.toolName, stage: input.conductor?.stage } : {}) });
    return call(method, ...args);
  };
  return transport;
}
function send(response, delta, finish_reason = null) {
  response.write(`data: ${JSON.stringify({ id: "owned-desktop-fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
}
function complete(response, value) {
  send(response, { role: "assistant", content: JSON.stringify(value) }); send(response, {}, "stop");
  response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}
function tool(response, name, args) {
  send(response, { role: "assistant", tool_calls: [{ index: 0, id: `owned-${randomUUID()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  send(response, {}, "tool_calls"); response.end("data: [DONE]\n\n");
}

try {
  await Promise.all([mkdir(home), mkdir(repo), mkdir(data)]);
  const env = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
    XDG_DATA_HOME: home, TMPDIR: home, TMP: home, TEMP: home, PATH: [dirname(process.execPath), dirname(docker)].join(delimiter),
    HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1",
    ...(originalEnv.SystemRoot ? { SystemRoot: originalEnv.SystemRoot } : {}), ...(originalEnv.WINDIR ? { WINDIR: originalEnv.WINDIR } : {}) };
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env); process.chdir(home);
  const { currentAuditHash } = await import("../dist/engine.mjs");
  server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer task-owned-desktop-api-key");
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert.ok(size < 8 * 1024 * 1024); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, "fixture-model");
      const task = JSON.parse(text(body.messages.find(message => message.role === "user").content));
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      // Reuse the established service fixture's exact report contracts, over real SSE.
      if (!task.identity?.stage) {
        assert.equal(body.tools, undefined);
        providerCalls.push({ stage: "devils-advocate", mode: "critic", workerId: task.identity.critic_child_id });
        return complete(response, { ...task.identity, purpose: "analysis", findings: [], conclusion: "holds", summary: "Captured source supports the bounded fixture answer." });
      }
      const { identity, input: run, requiredQualityCommands } = task;
      providerCalls.push({ ...identity });
      const names = new Map(body.messages.flatMap(message => message.tool_calls ?? []).map(call => [call.id, call.function.name]));
      const tools = body.messages.filter(message => message.role === "tool").map(message => ({ ...JSON.parse(text(message.content)), toolName: names.get(message.tool_call_id) }));
      assert.ok(tools.every(value => !value.error && !value.code), "Real fixture tools must succeed");
      const quality = tools.filter(value => value.evidenceId);
      if (identity.stage === "detective" && !tools.some(value => value.toolName === "read" && value.tag)) return tool(response, "read", { path: "fixture.txt" });
      if (identity.stage === "headsman" && !tools.some(value => value.toolName === "write")) return tool(response, "write", { path: "fixture.txt", content: "after\n" });
      if (requiredQualityCommands.length && !quality.length) {
        assert.deepEqual(requiredQualityCommands.map(command => command.id), ["node-tests"]);
        return tool(response, "quality", { commandId: "node-tests" });
      }
      for (const record of quality) {
        assert.equal(record.outcome, "passed", `Actual quality output: ${JSON.stringify(record)}`); assert.match(record.stdout, /owned fixture changed/);
        outcomes.push({ kind: "quality-tool-output", ...identity, evidenceId: record.evidenceId, stdoutSha256: sha256(record.stdout) });
      }
      if (run.admission.purpose === "analysis") {
        const material = run.admission.materials.find(item => item.selector === "fixture.txt");
        if (identity.stage === "arbiter") return complete(response, { run_id: run.runId, purpose: "analysis", candidate_hash: run.reportCandidates.at(-1).hash,
          challenge_hash: run.analysisChallenges.at(-1).hash, audit_hash: currentAuditHash(run), decision: "accept", basis: ["Bounded fixture evidence."], evidence_reviewed: [material.id], open_risks: [] });
        const value = { run_id: run.runId, purpose: "analysis", stage: identity.stage, deliverable: "answer", status: "ready", summary: "Observed owned fixture without writes.",
          material_ids: [material.id], blockers: [], assumptions: [], limitations: ["Fixture responses do not prove live-model quality."] };
        if (identity.mode === "producer") value.candidate = { version: "v1", deliverable: "answer", content: "The owned fixture says before.",
          criteria: run.acceptanceCriteria.map(criterion => ({ criterion, outcome: "Owned source read." })), material_ids: [material.id],
          material_spans: [{ material_id: material.id, start_line: 1, end_line: 2 }], assumptions: [], limitations: [] };
        else value.candidate_hash = run.reportCandidates.at(-1).hash;
        return complete(response, value);
      }
      if (identity.stage === "arbiter") return complete(response, { run_id: run.runId, decision: "go", basis: ["Actual fixture write and independent D/E node --test completed."],
        evidence_reviewed: ["fixture.txt", ...run.qualityExecutions.map(record => record.evidenceId)], conditions: [], open_risks: [], required_follow_up: ["No commit, merge, deployment or publication is authorized."] });
      const value = { run_id: run.runId, stage: identity.stage, baseline_ref: run.sourceBaseline, status: "ready", summary: "Owned local provider-contract fixture.",
        evidence: [{ kind: "file", reference: "fixture.txt", outcome: "Owned fixture evidence." }], findings: [], assumptions: [], blockers: [], artifacts: [], change_requests: [],
        quality_evidence_ids: quality.map(record => record.evidenceId), recommended_transition: { target: "conductor", rationale: "Harness evaluates this report." }, confidence: "high" };
      if (identity.stage === "detective") value.source_baseline = run.sourceBaseline;
      if (identity.stage === "devils-advocate") value.execution_baseline = { scopeVersion: "scope-1", planVersion: "plan-1", acceptanceVersion: "accept-1",
        rollbackReference: run.sourceBaseline, qualityCommandIds: run.ownerCapabilities.qualityCommandIds };
      complete(response, value);
    } catch (error) { faults.push(String(error)); response.destroy(error); }
  });
  await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  restoreNetwork = await installNetworkGuard(origin);
  const guard = join(root, "network-guard.mjs");
  await writeFile(guard, `await (${installNetworkGuard.toString()})(${JSON.stringify(origin)});\n`, { flag: "wx" });
  const { HostProcess } = await import("../../host-runtime/dist/host-process.js");
  const { AgentSidecar } = await import("../../host-runtime/dist/agent-sidecar.js");
  const shared = await import("../../shared/dist/index.js");
  const protocol = await import("../../shared/dist/protocol.js");
  register(new URL("../../../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
  const { registerConductorIpc } = await import("../../../apps/desktop/electron/main/ipc/conductor-ipc.ts");
  const { createSessionLaunchRuntime } = await import("../../../apps/desktop/electron/main/runtime/session-launch.ts");
  const { createProviderCatalogRuntime } = await import("../../../apps/desktop/electron/main/runtime/provider-catalog.ts");
  const { createSessionCoordination } = await import("../../../apps/desktop/electron/main/runtime/session-coordination.ts");
  const { ModelsDevCatalog } = await import("../../../apps/desktop/electron/main/models-dev-catalog.ts");
  const { resolveConductorDocker } = await import("../../../apps/desktop/electron/main/conductor/quality.ts");
  const require = createRequire(new URL("../../../apps/desktop/package.json", import.meta.url));
  const ts = require("typescript");
  const metadataPath = join(root, "models-fixture.json");
  await writeFile(metadataPath, JSON.stringify({ custom: { id: "custom", name: "Owned fixture", api: `${origin}/v1`, models: {
    "fixture-model": { id: "fixture-model", name: "Owned fixture model", reasoning: false, tool_call: true,
      modalities: { input: ["text"], output: ["text"] }, limit: { context: 128000, output: 8192 } } } } }));
  const modelsDevCatalog = new ModelsDevCatalog({ catalogPath: metadataPath });
  assert.equal(await modelsDevCatalog.ensureLoaded(), true, "Use the real catalog parser on owned external metadata");
  host = observe(new HostProcess({ binaryPath: resolve(hostBinary), dataDir: data, env, onStderr() {} }), "host");
  host.onNotification((method, params) => { if (method === "permissions.request") permissionRequests.push(params); });
  await host.call("app.handshake", { protocolVersion: shared.PROTOCOL_VERSION });
  const bundle = fileURLToPath(new URL("../../agent-runtime/dist-bundle/sidecar.js", import.meta.url));
  function startSidecar(entry = bundle) {
    const child = observe(new AgentSidecar({ launch: { command: process.execPath, args: ["--import", pathToFileURL(guard).href, entry], env, cwd: home },
      onStderr() {} }), "sidecar");
    child.setHost(host);
    child.onNotification((method, params) => { if (method === "conductor.fault") faults.push(params.code); });
    return child;
  }
  sidecar = startSidecar();
  const getHost = () => host;
  const providerCatalog = createProviderCatalogRuntime({ getHost, modelsDevCatalog });
  // Deliberately omit unused chat/plugin/OAuth dependencies: this direct-provider
  // path must not access them, shell discovery, prompts or user configuration.
  const launchRuntime = createSessionLaunchRuntime({ runtimeState: { host }, modelsDevCatalog,
    bindingForModel: providerCatalog.bindingForModel, effectiveSubagentModelConfig: providerCatalog.effectiveSubagentModelConfig,
    normalizeThinkingLevel: providerCatalog.normalizeThinkingLevel });
  const frame = {}, windowFixture = { isDestroyed: () => false, webContents: { id: 731, mainFrame: frame } };
  let event = { sender: { id: 731 }, senderFrame: frame };
  const activeTurns = new Map(), handlers = new Map(), listeners = new Map();
  const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => windowFixture, getViewingSessionId: () => null });
  // This is the ONLY Electron boundary fixture; no backend responses are substituted.
  const registrar = { handleWithEvent: (channel, handler) => handlers.set(channel, handler), assertMainWindowSender(ev) {
    if (ev.sender.id !== windowFixture.webContents.id) throw Object.assign(new Error("PERMISSION_DENIED"), { errorCode: "PERMISSION_DENIED" });
  } };
  registerConductorIpc({ registrar, getMainWindow: () => windowFixture, getHost, getSidecar: () => sidecar,
    activeTurns, acquireSessionOperation: coordination.acquireSessionOperation, resolveRuntimeProvider: launchRuntime.resolveRuntimeProvider });
  function load(relative, imports, globals = {}) {
    const url = new URL(relative, import.meta.url);
    const { outputText } = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: fileURLToPath(url) });
    const module = { exports: {} };
    new Function("require", "exports", "module", ...Object.keys(globals), outputText)(id => {
      assert.ok(Object.hasOwn(imports, id), `Unexpected dependency ${id}`); return imports[id];
    }, module.exports, module, ...Object.values(globals));
    return module.exports;
  }
  let bridge;
  const ipcRenderer = {
    invoke: async (channel, ...args) => {
      calls.push({ boundary: "electron", channel });
      assert.ok(handlers.has(channel), `Unregistered fixture channel ${channel}`);
      try { return shared.ok(await handlers.get(channel)(event, ...structuredClone(args))); }
      catch (error) { return shared.err(error?.data?.errorCode || error.errorCode || "INTERNAL", error.message, { details: error?.data }); }
    },
    on: (channel, listener) => { const entries = listeners.get(channel) ?? new Set(); entries.add(listener); listeners.set(channel, entries); },
    removeListener: (channel, listener) => { listeners.get(channel)?.delete(listener); },
  };
  load("../../../apps/desktop/electron/preload/index.ts", { electron: { contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "piDesktop"); bridge = value; } }, ipcRenderer, webUtils: {} }, "@pi-desktop/shared/protocol": protocol });
  const { api } = load("../../../apps/desktop/src/lib/api.ts", { "@pi-desktop/shared": shared }, { window: { piDesktop: bridge } });
  const availability = await api.conductorAvailability(); assert.equal(availability.available, true);
  assert.equal(availability.provenance.revision, "879ab27bdd22203675d6f0cc678652779fc089cd");
  result.provenance = availability.provenance;
  const { commands } = await api.conductorCatalog();
  assert.equal(commands.length, 1); assert.equal(commands[0].id, "node-tests"); assert.equal(commands[0].image, cachedImage);
  assert.deepEqual(commands[0].argv, ["/usr/local/bin/node", "--test", "--test-isolation=none"]); assert.deepEqual(commands[0].requiredGates, ["D", "E"]);
  assert.equal(resolve(await resolveConductorDocker(commands)), resolve(docker), "Explicit Docker must match the actual main-process fixed-location resolver");
  await writeFile(join(repo, "fixture.test.cjs"), "const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\nconst path = require('node:path');\ntest('owned fixture changed', () => { assert.equal(fs.readFileSync(path.join(__dirname, 'fixture.txt'), 'utf8'), 'after\\n'); });\n", { flag: "wx" });
  const testHash = sha256(await readFile(join(repo, "fixture.test.cjs")));
  const { provider } = await host.call("providers.create", { name: "Owned desktop API fixture", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
    baseUrl: `${origin}/v1`, authKind: "api_key_and_base_url", defaultModelId: "fixture-model", secretValue: "task-owned-desktop-api-key", apiStyle: "chat_completions" });
  assert.equal(provider.hasSecret, true);
  const entry = sessionId => ({ sessionId, requestId: randomUUID(), objective: "Assess only the owned fixture.", purpose: "analysis", scope: ["fixture.txt"],
    allowedPaths: [], excludedPaths: [], acceptanceCriteria: ["Observe the actual fixture."], materialPaths: ["fixture.txt"], qualityCommandIds: [] });
  const backendCount = () => calls.filter(call => call.boundary !== "electron").length;
  async function rejectedBeforeEffects(label, action, expected) {
    const count = backendCount(), requests = providerCalls.length;
    await assert.rejects(action, expected); assert.equal(backendCount(), count); assert.equal(providerCalls.length, requests);
    outcomes.push({ kind: "negative", label, backendEffects: 0, providerRequests: 0 });
  }
  for (const purpose of ["analysis", "implementation"]) {
    await writeFile(join(repo, "fixture.txt"), "before\n");
    const { session } = await host.call("session.create", { title: `Owned desktop API ${purpose}`, mode: "agent", projectPath: repo, providerId: provider.id, modelId: "fixture-model" });
    ownedSessions.add(session.id);
    await host.call("session.configure", { id: session.id, mode: "agent", permissionMode: "ask", thinkingLevel: "off" });
    const input = entry(session.id);
    if (purpose === "analysis") {
      for (const invalidEvent of [{ sender: { id: 999 }, senderFrame: frame }, { sender: { id: 731 }, senderFrame: {} }, { sender: { id: 731 } }]) {
        const validEvent = event; event = invalidEvent;
        try { await rejectedBeforeEffects("sender/main-frame", () => api.conductorStart(input), /PERMISSION_DENIED/); } finally { event = validEvent; }
      }
      windowFixture.isDestroyed = () => true;
      try { await rejectedBeforeEffects("destroyed-window", () => api.conductorAvailability(), /PERMISSION_DENIED/); } finally { windowFixture.isDestroyed = () => false; }
      for (const patch of [{ launch: {} }, { provider: {} }, { projectPath: repo }, { qualityCommands: commands }, { scope: ["../foreign"] }, { qualityCommandIds: ["node-tests"] }]) {
        await rejectedBeforeEffects("launch/mandate-injection", () => api.conductorStart({ ...input, ...patch }), /CONDUCTOR_INPUT_/);
      }
      await assert.rejects(bridge.invoke("pi-desktop/conductorStore/append", {}), /not allowed/);
    } else Object.assign(input, { purpose, objective: "Change only fixture.txt from before to after and verify the existing test.", allowedPaths: ["fixture.txt"], qualityCommandIds: ["node-tests"] });
    const beforeRequests = providerCalls.length, beforeCalls = calls.length;
    const initial = await api.conductorStart(input), ref = { sessionId: session.id, runId: initial.index.runId };
    assert.equal(initial.checkpoint.currentStage, "detective");
    let completed, consent = null; const answered = new Set(), writePermissions = new Set();
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      assert.deepEqual(faults, []);
      const loaded = await api.conductorHistory(ref);
      if (loaded.pendingConsent && !consent) {
        assert.equal(purpose, "implementation"); assert.equal(await readFile(join(repo, "fixture.txt"), "utf8"), "before\n");
        const pending = loaded.pendingConsent;
        assert.equal(pending.sessionId, session.id); assert.equal(pending.runId, ref.runId);
        consent = { sessionId: pending.sessionId, runId: pending.runId, requestId: pending.requestId, baselineHash: pending.baselineHash, approve: true };
        await assert.rejects(api.conductorAuthorize({ ...consent, requestId: randomUUID() }), /CONDUCTOR_CONSENT_STALE/);
        assert.deepEqual((await api.conductorHistory(ref)).pendingConsent, pending);
        assert.deepEqual(await api.conductorAuthorize(consent), { acknowledged: true });
        outcomes.push({ kind: "explicit-owner-consent", ...consent, baseline: pending.baseline, effectProfile: pending.effectProfile });
      }
      for (const permission of permissionRequests.filter(value => value.sessionId === session.id && !answered.has(value.requestId))) {
        assert.ok(ownedSessions.has(permission.sessionId));
        assert.ok(["Read", "Write"].includes(permission.toolName), "Fixture never approves shell or unrelated tool requests");
        if (permission.toolName === "Write") {
          assert.equal(purpose, "implementation"); assert.ok(consent);
          assert.equal(await readFile(join(repo, "fixture.txt"), "utf8"), "before\n", "Owner consent does not bypass the separate existing write permission");
          writePermissions.add(permission.requestId);
        }
        // Existing Rust permission/UI fixture, separate from the Gate-C owner answer.
        // Never grant allow-session/auto, and never resolve another owner's request.
        answered.add(permission.requestId);
        await host.call("permissions.resolve", { requestId: permission.requestId, decision: "allow-once" });
        outcomes.push({ kind: "permission-ui-fixture", sessionId: session.id, requestId: permission.requestId, toolName: permission.toolName, decision: "allow-once" });
      }
      if (["completed", "failed", "cancelled", "interrupted"].includes(loaded.index.status) || loaded.checkpoint.status === "escalated") { completed = loaded; break; }
      await delay(10); // Bounded condition polling; never used as evidence of completion.
    }
    assert.ok(completed, "Owned API run did not settle before its deadline");
    assert.equal(completed.index.status, "completed"); assert.deepEqual(completed.resourceIssues, []);
    assert.deepEqual(completed.intake.engine, availability.provenance);
    const checkpoint = completed.checkpoint;
    assert.equal(checkpoint.status, purpose === "analysis" ? "reported" : "awaiting_authorization");
    const projection = completed.projection;
    assert.equal(projection.recordFormat, 5); assert.equal(projection.purpose, purpose); assert.equal(projection.motorStatus, checkpoint.status);
    assert.equal(projection.workers.length, purpose === "analysis" ? 4 : 7);
    assert.equal(new Set(projection.workers.map(worker => worker.dispatchId)).size, projection.workers.length);
    assert.ok(projection.workers.every(worker => worker.status === "completed" && worker.output && worker.inputHash && worker.workerId));
    assert.deepEqual(projection.gateHistory.map(gate => [gate.gate, gate.decision]), checkpoint.history.map(gate => [gate.gate, gate.decision]));
    assert.ok(projection.reports.some(report => report.kind === "decision" && report.stage === "arbiter"));
    assert.equal(projection.next, purpose === "analysis" ? "none" : "external-authorization");
    const decision = purpose === "analysis" ? checkpoint.reportDecision : checkpoint.decision;
    assert.deepEqual(projection.arbiterDecision, { purpose, outcome: decision.decision, basis: decision.basis, evidenceReviewed: decision.evidence_reviewed });
    assert.equal(sha256(await readFile(join(repo, "fixture.test.cjs"))), testHash, "Test fixture is never rewritten by implementation");
    if (purpose === "analysis") {
      assert.equal(consent, null); assert.equal(checkpoint.reportDecision.decision, "accept");
      assert.ok(calls.slice(beforeCalls).filter(call => call.method === "tools.execute").every(call => call.toolName === "Read"), "Analysis must execute only the real read tool, never writes or shell commands");
      assert.ok(checkpoint.analysisChallenges.length > 0); assert.ok(checkpoint.reportCandidates.length > 0);
      assert.ok(providerCalls.slice(beforeRequests).some(call => call.mode === "critic" && call.workerId));
      assert.deepEqual(checkpoint.history.filter(record => record.kind === "skipped").map(record => record.gate), ["B", "D", "F"]);
      assert.deepEqual(checkpoint.qualityExecutions, []); assert.equal(await readFile(join(repo, "fixture.txt"), "utf8"), "before\n");
    } else {
      assert.ok(consent); assert.ok(writePermissions.size > 0, "Actual Rust write permission must be answered separately from owner consent");
      assert.deepEqual(checkpoint.history.map(record => record.gate), ["A", "B", "C", "D", "E", "F", "G"]);
      assert.equal(checkpoint.decision.decision, "go"); assert.equal(checkpoint.closeout, undefined, "GO never grants external release authority");
      const records = checkpoint.qualityExecutions;
      assert.equal(records.length, 2); assert.deepEqual(records.map(record => record.gate), ["D", "E"]);
      assert.equal(new Set(records.map(record => record.childSessionId)).size, 2); assert.equal(new Set(records.map(record => record.evidenceId)).size, 2);
      for (const record of records) {
        assert.equal(record.commandId, "node-tests"); assert.equal(record.outcome, "passed"); assert.equal(record.exitCode, 0);
        assert.ok(outcomes.some(item => item.kind === "quality-tool-output" && item.evidenceId === record.evidenceId && item.stdoutSha256 === record.stdoutSha256));
      }
      assert.equal(await readFile(join(repo, "fixture.txt"), "utf8"), "after\n");
    }
    assert.ok((await api.conductorList(session.id)).runs.some(run => run.runId === ref.runId));
    const requests = providerCalls.length, secretReads = calls.filter(call => call.method === "providers.getSecret").length;
    await sidecar.dispose(); sidecar = startSidecar();
    for (let repeat = 0; repeat < 2; repeat++) assert.deepEqual(await api.conductorHistory(ref), completed, "Actual sidecar restart must preserve identical persisted API history");
    await api.conductorList(session.id);
    assert.equal(providerCalls.length, requests, "History/list/restart never replays a provider request");
    assert.equal(calls.filter(call => call.method === "providers.getSecret").length, secretReads, "History never resolves credentials");
    outcomes.push({ kind: "run", purpose, ...ref, status: checkpoint.status, history: checkpoint.history, quality: checkpoint.qualityExecutions,
      criticCount: providerCalls.slice(beforeRequests).filter(call => call.mode === "critic").length, restartHistoryIdentical: true, historyProviderRequests: 0, externalActionAuthorized: false });
  }
  // Missing-engine test alters ONLY a task-owned copy, never task build outputs.
  await sidecar.dispose(); sidecar = undefined;
  const missingBundle = join(root, "missing-runtime");
  await cp(dirname(bundle), missingBundle, { recursive: true, dereference: false });
  await rm(join(missingBundle, "node_modules", "@pi-desktop", "conductor-runtime"), { recursive: true });
  sidecar = startSidecar(join(missingBundle, "sidecar.js"));
  const missing = await api.conductorAvailability(); assert.equal(missing.available, false); assert.equal(missing.code, "CONDUCTOR_ENGINE_UNAVAILABLE");
  const before = calls.length, providerCount = providerCalls.length;
  await assert.rejects(api.conductorStart(entry([...ownedSessions][0])), /CONDUCTOR_ENGINE_UNAVAILABLE/);
  assert.deepEqual(calls.slice(before).filter(call => call.boundary !== "electron").map(call => call.method), ["conductor.availability"]);
  assert.equal(providerCalls.length, providerCount);
  outcomes.push({ kind: "missing-engine", availability: missing, providerRequests: 0, credentialReads: 0, genericChatFallback: false });
  assert.deepEqual(faults, []);
  assert.deepEqual(await readdir(join(data, "conductor-resources")), [], "Only registered owned quality resources must be removed");
  result.passed = true;
} catch (error) {
  failure = error; result.error = { name: error.name, message: error.message, stack: error.stack };
} finally {
  // Stop only fixture processes created above; a failure to clean up fails acceptance.
  for (const [name, dispose] of [["sidecar", () => sidecar?.dispose()], ["host", () => host?.dispose()]]) {
    try { await dispose(); } catch (error) { result.passed = false; faults.push(`${name} cleanup: ${error}`); failure ??= error; }
  }
  restoreNetwork?.();
  if (server?.listening) { server.closeAllConnections(); await new Promise(yes => server.close(yes)); }
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  try { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (error) { result.passed = false; faults.push(`Owned directory cleanup: ${error}`); failure ??= error; }
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n");
}
if (failure) throw failure;
console.log(`CONDUCTOR_DESKTOP_API_ACCEPTANCE_PASS: fixture-only actual API/preload/main/provider resolution/packaged sidecar/Harness/Rust chain; NOT native Electron/UI acceptance; ${resultPath}`);
