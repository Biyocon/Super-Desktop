// Test-only external provider contracts and pre-import network confinement.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

export const pinnedImage = "sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0";
export const sha256 = value => createHash("sha256").update(value).digest("hex");
const text = value => typeof value === "string" ? value : (value ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");

// Serialized into an owned CJS --require preload. It runs before the candidate
// main imports, and before each Electron-as-Node child imports its entry point.
// Never permit DNS names (including localhost), arbitrary loopback ports or IPC
// paths: the only outbound Node socket is the owned provider's numeric endpoint.
export function installNodeGuard(require, config) {
  const fs = require("node:fs"), net = require("node:net");
  const { syncBuiltinESMExports } = require("node:module");
  const cp = require("node:child_process");
  const endpoint = new URL(config.origin);
  const log = event => fs.appendFileSync(config.audit, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...event }) + "\n");
  const deny = kind => { log({ kind: "network-denied", operation: kind }); throw new Error(`HARNESS_ACCEPTANCE_NETWORK_DENIED: ${kind}`); };
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const values = Array.isArray(args[0]) ? args[0] : args;
    const first = values[0];
    const options = first && typeof first === "object" ? first : { port: first, host: typeof values[1] === "string" ? values[1] : undefined };
    if (options.path || options.host !== "127.0.0.1" || String(options.port) !== endpoint.port) return deny("socket");
    return Reflect.apply(original, this, args);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== config.origin) return deny("fetch");
    return originalFetch(input, { ...init, redirect: "error" });
  };
  // DNS/UDP can otherwise bypass a TCP-only guard. No app feature in this test
  // needs them; local Docker uses its fixed native pipe through the real CLI.
  const dns = require("node:dns"), promises = require("node:dns/promises");
  for (const key of Object.keys(dns)) if ((key === "lookup" || key.startsWith("resolve") || key === "reverse") && typeof dns[key] === "function") dns[key] = () => deny("dns");
  for (const key of Object.keys(promises)) if (typeof promises[key] === "function" && key !== "Resolver") promises[key] = () => deny("dns-promises");
  dns.Resolver = class { constructor() { deny("dns-resolver"); } };
  promises.Resolver = class { constructor() { deny("dns-promises-resolver"); } };
  require("node:dgram").createSocket = () => deny("udp");
  const spawn = cp.spawn;
  cp.spawn = function (command, args = [], options) {
    // Security preload only: no replacement entry, tool result, host call or
    // runtime state. Keep the actual shipped sidecar and all its arguments.
    const guarded = command === process.execPath && options?.env?.ELECTRON_RUN_AS_NODE === "1";
    const child = Reflect.apply(spawn, this, [command, guarded ? ["--require", config.guard, ...args] : args, options]);
    log({ kind: "child-start", childPid: child.pid, command, guarded });
    child.once("exit", (code, signal) => log({ kind: "child-exit", childPid: child.pid, code, signal }));
    return child;
  };
  syncBuiltinESMExports();
  log({ kind: "guard-installed", origin: config.origin });
  // Synchronous negative probes cannot leave this process. A broken guard must
  // fail closed before any candidate import, rather than merely being logged.
  let fetchDenied = false, socketDenied = false;
  try { globalThis.fetch("https://non-fixture.invalid/"); } catch (error) { fetchDenied = error.message.startsWith("HARNESS_ACCEPTANCE_NETWORK_DENIED"); }
  const probe = new net.Socket();
  try { probe.connect({ host: "192.0.2.1", port: 443 }); } catch (error) { socketDenied = error.message.startsWith("HARNESS_ACCEPTANCE_NETWORK_DENIED"); }
  finally { probe.destroy(); }
  if (!fetchDenied || !socketDenied) throw new Error("HARNESS_ACCEPTANCE_GUARD_SELF_TEST_FAILED");
  log({ kind: "guard-self-test", fetchDenied, socketDenied });
}

export function providerFixture({ currentAuditHash, requests, outcomes, faults, key }) {
  const send = (response, delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "owned-native-fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  const complete = (response, value) => {
    send(response, { role: "assistant", content: JSON.stringify(value) }); send(response, {}, "stop");
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  };
  const tool = (response, name, args) => {
    send(response, { role: "assistant", tool_calls: [{ index: 0, id: `native-${randomUUID()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    send(response, {}, "tool_calls"); response.end("data: [DONE]\n\n");
  };
  return async (request, response) => {
    try {
      assert.equal(request.method, "POST"); assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert.ok(size < 8 * 1024 * 1024); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, "fixture-model");
      const task = JSON.parse(text(body.messages.find(message => message.role === "user").content));
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (!task.identity?.stage) {
        assert.equal(body.tools, undefined);
        requests.push({ stage: "devils-advocate", mode: "critic", workerId: task.identity.critic_child_id });
        return complete(response, { ...task.identity, purpose: "analysis", findings: [], conclusion: "holds", summary: "Captured source supports the bounded fixture answer." });
      }
      const { identity, input: run, requiredQualityCommands } = task;
      requests.push({ ...identity });
      const names = new Map(body.messages.flatMap(message => message.tool_calls ?? []).map(call => [call.id, call.function.name]));
      const tools = body.messages.filter(message => message.role === "tool").map(message => ({ ...JSON.parse(text(message.content)), toolName: names.get(message.tool_call_id) }));
      assert.ok(tools.every(value => !value.error && !value.code), "Actual fixture tools must succeed");
      const quality = tools.filter(value => value.evidenceId);
      if (identity.stage === "detective" && !tools.some(value => value.toolName === "read" && value.tag)) return tool(response, "read", { path: "fixture.txt" });
      if (identity.stage === "headsman" && !tools.some(value => value.toolName === "write")) return tool(response, "write", { path: "fixture.txt", content: "after\n" });
      if (requiredQualityCommands.length && !quality.length) {
        assert.deepEqual(requiredQualityCommands.map(command => command.id), ["node-tests"]);
        return tool(response, "quality", { commandId: "node-tests" });
      }
      for (const record of quality) {
        assert.equal(record.outcome, "passed", JSON.stringify(record)); assert.match(record.stdout, /owned fixture changed/);
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
      const value = { run_id: run.runId, stage: identity.stage, baseline_ref: run.sourceBaseline, status: "ready", summary: "Owned native provider-contract fixture.",
        evidence: [{ kind: "file", reference: "fixture.txt", outcome: "Owned fixture evidence." }], findings: [], assumptions: [], blockers: [], artifacts: [], change_requests: [],
        quality_evidence_ids: quality.map(record => record.evidenceId), recommended_transition: { target: "conductor", rationale: "Harness evaluates this report." }, confidence: "high" };
      if (identity.stage === "detective") value.source_baseline = run.sourceBaseline;
      if (identity.stage === "devils-advocate") value.execution_baseline = { scopeVersion: "scope-1", planVersion: "plan-1", acceptanceVersion: "accept-1",
        rollbackReference: run.sourceBaseline, qualityCommandIds: run.ownerCapabilities.qualityCommandIds };
      complete(response, value);
    } catch (error) { faults.push(String(error)); response.destroy(error); }
  };
}
