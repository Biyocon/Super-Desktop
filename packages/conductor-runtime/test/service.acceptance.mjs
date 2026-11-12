// Real service/transport/driver/journal/host tools/quality. Only provider replies
// and owner/permission UI answers are local fixtures; NOT desktop/live acceptance.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Host } from "../../../scripts/e2e/host.mjs";
import { currentAuditHash } from "../dist/engine.mjs";
import { conductorLoader } from "../../agent-runtime/dist/conductor/loader.js";

const resourceLoss = process.argv.includes("--resource-loss");
const sidecarMode = resourceLoss || process.argv.includes("--sidecar");
let sidecar, hostTransport, recreateSidecar;
const [binary, docker, image, scratch] = process.argv.slice(2);
assert.ok(binary && docker && /^sha256:[a-f0-9]{64}$/.test(image) && scratch, "Explicit owned binary, cached Docker/image and scratch required");
const root = await mkdtemp(join(resolve(scratch), "conductor-service-"));
const repo = join(root, "repo"), data = join(root, "data"), home = join(root, "home");
await Promise.all([mkdir(repo), mkdir(data), mkdir(home)]);
const previous = Object.fromEntries(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].map(key => [key, process.env[key]]));
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home });
let host = new Host(resolve(binary), data);
const calls = [], faults = [], outcomes = [];
const text = content => typeof content === "string" ? content : (content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
function send(response, delta, reason = null) {
  response.write(`data: ${JSON.stringify({ id: "owned-fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`);
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
const server = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const task = JSON.parse(text(body.messages.find(message => message.role === "user").content));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    // Critic gets the exact independently captured JSON prompt, no run/history/tools.
    if (!task.identity?.stage) {
      assert.equal(body.tools, undefined);
      calls.push({ stage: "devils-advocate", mode: "critic", workerId: task.identity.critic_child_id });
      complete(response, { ...task.identity, purpose: "analysis", findings: [], conclusion: "holds", summary: "The exact captured source supports the bounded fixture answer." });
      return;
    }
    const { identity, input: run, requiredQualityCommands } = task;
    if (!calls.some(call => call.dispatchId === identity.dispatchId)) calls.push(identity);
    const toolNames = new Map(body.messages.flatMap(message => message.tool_calls ?? []).map(call => [call.id, call.function.name]));
    const results = body.messages.filter(message => message.role === "tool").map(message => {
      const content = text(message.content);
      let parsed; try { parsed = JSON.parse(content); } catch { throw new Error(`Owned tool failed: ${content}`); }
      return { ...parsed, toolName: toolNames.get(message.tool_call_id) };
    });
    const hasRead = results.some(result => result.toolName === "read" && result.tag);
    const hasWrite = results.some(result => result.toolName === "write");
    const quality = results.filter(result => result.evidenceId);
    assert.ok(results.every(result => !result.error && !result.code), "Owned tool must actually succeed");
    if (identity.stage === "detective" && !hasRead) return tool(response, "read", { path: "fixture.txt" });
    if (identity.stage === "headsman" && !hasWrite) return tool(response, "write", { path: "fixture.txt", content: "after\n" });
    if (requiredQualityCommands.length && !quality.length) return tool(response, "quality", { commandId: requiredQualityCommands[0].id });
    if (run.admission.purpose === "analysis") {
      const material = run.admission.materials.find(item => item.selector === "fixture.txt");
      if (identity.stage === "arbiter") return complete(response, { run_id: run.runId, purpose: "analysis", candidate_hash: run.reportCandidates.at(-1).hash,
        challenge_hash: run.analysisChallenges.at(-1).hash, audit_hash: currentAuditHash(run), decision: "accept", basis: ["Bounded fixture evidence."], evidence_reviewed: [material.id], open_risks: [] });
      const value = { run_id: run.runId, purpose: "analysis", stage: identity.stage, deliverable: "answer", status: "ready", summary: "Observed owned fixture without writes.",
        material_ids: [material.id], blockers: [], assumptions: [], limitations: ["Provider output is a local fixture, not live model quality."] };
      if (identity.mode === "producer") value.candidate = { version: "v1", deliverable: "answer", content: "The owned fixture says before.",
        criteria: run.acceptanceCriteria.map(criterion => ({ criterion, outcome: "Owned source read." })), material_ids: [material.id],
        material_spans: [{ material_id: material.id, start_line: 1, end_line: 2 }], assumptions: [], limitations: [] };
      else value.candidate_hash = run.reportCandidates.at(-1).hash;
      return complete(response, value);
    }
    if (identity.stage === "arbiter") return complete(response, { run_id: run.runId, decision: "go", basis: ["Actual owned change and independent D/E commands completed."],
      evidence_reviewed: ["fixture.txt", ...run.qualityExecutions.map(record => record.evidenceId)], conditions: [], open_risks: [], required_follow_up: ["No release, deployment or merge is authorized."] });
    const value = { run_id: run.runId, stage: identity.stage, baseline_ref: run.sourceBaseline, status: "ready", summary: "Owned local provider-contract fixture.",
      evidence: [{ kind: "file", reference: "fixture.txt", outcome: "Owned fixture evidence." }], findings: [], assumptions: [], blockers: [], artifacts: [], change_requests: [],
      quality_evidence_ids: quality.map(result => result.evidenceId), recommended_transition: { target: "conductor", rationale: "Harness evaluates this report." }, confidence: "high" };
    if (identity.stage === "detective") value.source_baseline = run.sourceBaseline;
    if (identity.stage === "devils-advocate") value.execution_baseline = { scopeVersion: "scope-1", planVersion: "plan-1", acceptanceVersion: "accept-1",
      rollbackReference: run.sourceBaseline, qualityCommandIds: run.ownerCapabilities.qualityCommandIds };
    complete(response, value);
  } catch (error) { faults.push(String(error)); response.destroy(error); }
});
let loader;
const realFetch = globalThis.fetch;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== origin) throw new Error("Non-fixture network denied");
    return realFetch(input, init);
  };
  await host.start();
  if (sidecarMode) {
    // Use the production parent transport and a real, isolated packaged child.
    await host.stop();
    const { HostProcess } = await import("../../host-runtime/dist/host-process.js");
    const { AgentSidecar } = await import("../../host-runtime/dist/agent-sidecar.js");
    hostTransport = new HostProcess({ binaryPath: resolve(binary), dataDir: data, onStderr() {} });
    const notifications = [];
    hostTransport.onNotification((method, params) => notifications.push({ method, params }));
    host = { notifications, call: (...args) => hostTransport.call(...args), stop: () => hostTransport.dispose() };
    await host.call("app.handshake", { protocolVersion: 11 });
    const { fileURLToPath } = await import("node:url");
    recreateSidecar = () => {
      const child = new AgentSidecar({ launch: { command: process.execPath,
        args: [fileURLToPath(new URL("../../agent-runtime/dist-bundle/sidecar.js", import.meta.url))],
        env: { ...process.env, HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" }, cwd: home }, onStderr() {} });
      child.setHost(hostTransport);
      child.onNotification((method, params) => { if (method === "conductor.fault") faults.push(params.code); });
      return child;
    };
    sidecar = recreateSidecar();
  }
  loader = sidecarMode ? { availability: () => sidecar.call("conductor.availability"),
    get: async () => ({ start: (request, launch) => sidecar.call("conductor.start", { sessionId: request.sessionId, request, launch }),
      history: (sessionId, runId) => sidecar.call("conductor.history", { sessionId, runId }),
      authorize: value => sidecar.call("conductor.authorize", { sessionId: value.sessionId, runId: value.runId, requestId: value.requestId, baselineHash: value.baselineHash, approve: value.approve }) }),
    dispose: async () => { await sidecar.call("conductor.dispose"); await sidecar.dispose(); } }
    : conductorLoader({ host, runtimeId: `owned-service-${randomUUID()}`, changed() {}, fault(_session, _run, code) { faults.push(code); } });
  assert.equal((await loader.availability()).available, true);
  const service = await loader.get();
  const launch = { provider: { id: "owned-provider", name: "Fixture", baseUrl: `${origin}/v1`, modelId: "fixture-model", apiKey: "task-owned-fixture-key",
    apiStyle: "openai-completions", authKind: "api-key", supportsReasoning: false, supportedThinkingLevels: ["off"] }, thinkingLevel: "off", dockerExecutable: resolve(docker), scratchRoot: root };
  for (const scenario of resourceLoss ? ["sidecar-loss", "host-loss"] : ["analysis", "implementation"]) {
    const purpose = resourceLoss ? "implementation" : scenario;
    await writeFile(join(repo, "fixture.txt"), "before\n");
    const { session } = await host.call("session.create", { title: `Owned service ${purpose}`, mode: "agent", projectPath: repo });
    await host.call("session.configure", { id: session.id, mode: "agent", permissionMode: "ask" });
    const start = { requestId: randomUUID(), sessionId: session.id, projectPath: repo, objective: "Assess the owned fixture only.", purpose,
      scope: ["fixture.txt"], allowedPaths: purpose === "implementation" ? ["fixture.txt"] : [], excludedPaths: [], acceptanceCriteria: ["Observe the actual fixture."], materialPaths: ["fixture.txt"],
      qualityCommands: purpose === "implementation" ? [{ id: "owned-check", image, argv: ["/usr/local/bin/node", "-e", "const fs=require('node:fs');if(fs.readFileSync('/workspace/fixture.txt','utf8')!=='after\\n')process.exit(7);try{fs.writeFileSync('/workspace/fixture.txt','forbidden')}catch(e){if(e.code==='EROFS'){console.log('actual after; read-only verified');process.exit(0)}throw e}process.exit(8)"], requiredGates: ["D", "E"], timeoutMs: 15000, outputLimitBytes: 2048 }] : [] };
    if (resourceLoss) {
      start.qualityCommands[0].argv = ["/usr/local/bin/node", "-e", "console.log('OWNED_QUALITY_RUNNING');setInterval(()=>{},1000)"];
      start.qualityCommands[0].timeoutMs = 300000;
    }
    if (sidecarMode) {
      const cancelled = { ...start, requestId: randomUUID() }, before = calls.length;
      const entry = sidecar.call("conductor.start", { sessionId: session.id, request: cancelled, launch }).catch(error => error);
      const abort = await sidecar.call("conductor.cancelAdmission", { sessionId: session.id, requestId: cancelled.requestId });
      assert.equal(abort.cancelled, true);
      assert.equal((await entry).errorCode, "CONDUCTOR_CANCELLED");
      assert.deepEqual((await sidecar.call("conductor.list", { sessionId: session.id })).runs, []);
      assert.equal(calls.length, before, "Immediate cancellation must not dispatch after engine loading");
    }
    const initial = await service.start(start, launch);
    assert.equal(initial.checkpoint.currentStage, "detective");
    assert.equal(initial.checkpoint.history.length, 0);
    const runId = initial.index.runId;
    let completed, consent = false;
    const answeredPermissions = new Set();
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const loaded = await service.history(session.id, runId);
      if (loaded.pendingConsent && !consent) {
        assert.equal(purpose, "implementation");
        assert.equal(await readFile(join(repo, "fixture.txt"), "utf8"), "before\n");
        await service.authorize({ ...loaded.pendingConsent, approve: true }); consent = true;
      }
      for (const note of host.notifications.filter(note => note.method === "permissions.request" && note.params.sessionId === session.id)) {
        if (!answeredPermissions.has(note.params.requestId)) { answeredPermissions.add(note.params.requestId); await host.call("permissions.resolve", { requestId: note.params.requestId, decision: "allow-once" }); }
      }
      if (resourceLoss) {
        const raw = await host.call("conductorStore.load", { sessionId: session.id, runId });
        const resource = raw.resources.find(item => !item.probe && !item.creationUncertain);
        if (resource) {
          const endpoint = process.platform === "win32" ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock";
          const inspect = () => spawnSync(docker, ["--config", home, "--host", endpoint, "inspect", "--format", "{{.State.Running}}", resource.containerName], { encoding: "utf8", shell: false, windowsHide: true, timeout: 10000 });
          if (inspect().stdout.trim() === "true") {
            const before = calls.length;
            if (scenario === "host-loss") await hostTransport.dispose();
            let disposeError;
            try { await sidecar.dispose(); } catch (error) { disposeError = error; }
            if (scenario === "host-loss") {
              if (disposeError) assert.match(String(disposeError), /CONDUCTOR_RECOVERY_FAILED/);
              assert.equal(inspect().stdout.trim(), "true", "Dead-host cleanup cannot be claimed before the replacement host recovers its record");
              const { HostProcess } = await import("../../host-runtime/dist/host-process.js");
              hostTransport = new HostProcess({ binaryPath: resolve(binary), dataDir: data, onStderr() {} });
              await host.call("app.handshake", { protocolVersion: 11 });
            } else assert.equal(disposeError, undefined);
            assert.equal(inspect().status, 1, "The exact registered running container must be absent after recovery");
            assert.deepEqual(await readdir(join(data, "conductor-resources")), [], "Only recorded temporary directories were removed");
            sidecar = recreateSidecar();
            const recovered = await service.history(session.id, runId);
            assert.equal(recovered.index.status, "interrupted");
            assert.deepEqual(recovered.resourceIssues, []);
            assert.deepEqual(recovered.checkpoint.history.map(item => item.gate), ["A", "B", "C"]);
            assert.equal(calls.length, before, "Recovery/history must not replay the interrupted worker");
            assert.equal(await readFile(join(repo, "fixture.txt"), "utf8"), "after\n", "Cancellation is not a claimed rollback");
            outcomes.push({ scenario, runId, containerName: resource.containerName, runningBeforeLoss: true, removed: true, temporaryRemoved: true, historyProviderRequests: 0 });
            completed = recovered;
            break;
          }
        }
      }
      if (["completed", "interrupted", "failed", "cancelled"].includes(loaded.index.status) || loaded.checkpoint.status === "escalated") { completed = loaded; break; }
      await delay(10); // Bounded condition polling, never presumed process completion.
    }
    assert.ok(completed, "Owned service did not settle");
    if (resourceLoss) { assert.equal(completed.index.status, "interrupted"); continue; }
    assert.deepEqual(faults, []);
    assert.equal(completed.index.status, "completed");
    assert.equal(completed.checkpoint.status, purpose === "analysis" ? "reported" : "awaiting_authorization");
    if (purpose === "analysis") {
      assert.equal(consent, false);
      assert.deepEqual(completed.checkpoint.history.filter(record => record.kind === "skipped").map(record => record.gate), ["B", "D", "F"]);
      assert.equal(await readFile(join(repo, "fixture.txt"), "utf8"), "before\n");
    } else {
      assert.equal(consent, true);
      assert.deepEqual(completed.checkpoint.history.map(record => record.gate), ["A", "B", "C", "D", "E", "F", "G"]);
      assert.equal(completed.checkpoint.qualityExecutions.length, 2);
      assert.ok(completed.checkpoint.qualityExecutions.every(record => record.outcome === "passed"));
      assert.equal(await readFile(join(repo, "fixture.txt"), "utf8"), "after\n");
      assert.equal((await host.call("conductorStore.validateSource", { sessionId: session.id, runId })).revision, 1);
    }
    const count = calls.length;
    await service.history(session.id, runId); await service.history(session.id, runId);
    assert.equal(calls.length, count, "History never replays a provider request");
    if (sidecarMode) {
      await sidecar.dispose(); // Real child termination, not a mocked reload.
      sidecar = recreateSidecar();
      const reopened = await service.history(session.id, runId);
      assert.deepEqual(reopened, completed, "Actual sidecar restart must preserve completed engine history exactly");
      assert.equal(calls.length, count, "Restart and history loading must not dispatch");
    }
    outcomes.push({ purpose, runId, status: completed.checkpoint.status, history: completed.checkpoint.history.map(record => ({ gate: record.gate, kind: record.kind })),
      workers: calls.filter(call => call.runId === runId || purpose === "analysis" && call.mode === "critic").map(call => ({ stage: call.stage, workerId: call.workerId })), qualityCount: completed.checkpoint.qualityExecutions.length });
  }
  await writeFile(join(resolve(scratch), resourceLoss ? "conductor-resources-result.json" : sidecarMode ? "conductor-sidecar-result.json" : "conductor-service-result.json"), JSON.stringify({ fixtureOnly: true, desktopWiringAccepted: false, actualServiceTransportAndHost: true, actualPackagedSidecar: sidecarMode, outcomes }, null, 2) + "\n");
  console.log(`${resourceLoss ? "CONDUCTOR_RESOURCES_ACCEPTANCE_PASS" : sidecarMode ? "CONDUCTOR_SIDECAR_ACCEPTANCE_PASS" : "CONDUCTOR_SERVICE_ACCEPTANCE_PASS"}: actual service/provider transport/Harness/Rust; owned resources; no automatic replay`);
} finally {
  await loader?.dispose();
  await host.stop();
  globalThis.fetch = realFetch;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
