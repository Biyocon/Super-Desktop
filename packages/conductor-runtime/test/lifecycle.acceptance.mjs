// Actual process loss, Rust fencing, lazy restart and explicit resume cancellation.
// The only provider is an owned loopback server that never returns a report.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { HostProcess } from "../../host-runtime/dist/host-process.js";
import { AgentSidecar } from "../../host-runtime/dist/agent-sidecar.js";

const [binary, scratch] = process.argv.slice(2);
assert.ok(binary && scratch, "Explicit owned host binary and scratch required");
const root = await mkdtemp(join(resolve(scratch), "conductor-lifecycle-"));
const home = join(root, "home"), repo = join(root, "repo");
await mkdir(home); await mkdir(repo); await writeFile(join(repo, "fixture.txt"), "before\n");
let calls = 0, host, sidecar, displacedHost;
let accepted = false;
const identities = [];
const closedWorkers = new Set();
let requested;
const requestArrived = new Promise(resolve => { requested = resolve; });
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const content = body.messages.find(message => message.role === "user").content;
  identities.push(JSON.parse(typeof content === "string" ? content : content.map(part => part.text ?? "").join("\n")).identity);
  calls++; requested();
  const worker = identities.at(-1).workerId;
  response.once("close", () => closedWorkers.add(worker));
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.flushHeaders(); // Hold the real provider call until cancellation/exit.
});
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH,
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home,
    HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" };
  host = new HostProcess({ binaryPath: resolve(binary), dataDir: join(root, "data"), env, onStderr() {} });
  await host.call("app.handshake", { protocolVersion: 11 });
  const createSidecar = () => {
    const child = new AgentSidecar({ launch: { command: process.execPath,
      args: [fileURLToPath(new URL("../../agent-runtime/dist-bundle/sidecar.js", import.meta.url))], env, cwd: home }, onStderr() {} });
    child.setHost(host); return child;
  };
  sidecar = createSidecar();
  const { session } = await host.call("session.create", { title: "Owned sidecar loss", mode: "agent", projectPath: repo });
  const launch = { provider: { id: "owned", name: "Owned fixture", apiKey: "task-owned-fixture-key", authKind: "api-key", modelId: "fixture-model", apiStyle: "openai-completions",
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, supportsReasoning: false, supportedThinkingLevels: ["off"] },
    thinkingLevel: "off", dockerExecutable: join(root, "unused-docker"), scratchRoot: root };
  const initial = await sidecar.call("conductor.start", { sessionId: session.id, launch,
    request: { requestId: randomUUID(), sessionId: session.id, projectPath: repo, objective: "Observe owned fixture only.", purpose: "analysis", scope: ["fixture.txt"], allowedPaths: [], excludedPaths: [], acceptanceCriteria: ["No mutation."], materialPaths: [], qualityCommands: [] } });
  const runId = initial.index.runId;
  await Promise.race([requestArrived, delay(15000, undefined, { ref: false }).then(() => { throw new Error("Owned provider request did not arrive"); })]);
  await sidecar.dispose(); // Kill the actual child while its provider request waits.
  const stored = await host.call("conductorStore.load", { sessionId: session.id, runId });
  assert.equal(stored.run.status, "interrupted");
  assert.ok(stored.run.version > initial.index.version);
  const count = calls;
  sidecar = createSidecar();
  const reopened = await sidecar.call("conductor.history", { sessionId: session.id, runId });
  assert.equal(reopened.index.status, "interrupted");
  assert.equal(reopened.checkpoint.history.length, 0);
  assert.equal(calls, count, "Restart/history must never replay a provider request");
  const resuming = sidecar.call("conductor.resume", { sessionId: session.id, runId, expectedVersion: reopened.index.version, launch }).catch(error => error);
  const cancelled = await sidecar.call("conductor.cancel", { sessionId: session.id, runId });
  const resumed = await resuming;
  assert.ok(resumed.index || resumed.errorCode === "CONDUCTOR_CANCELLED", `Resume must be accepted or specifically cancelled: ${resumed.errorCode ?? "unknown"}`);
  const final = await sidecar.call("conductor.history", { sessionId: session.id, runId });
  assert.ok(["cancelled", "interrupted"].includes(cancelled.index.status));
  assert.ok(["cancelled", "interrupted"].includes(final.index.status), "A cancelled resume must not acquire a later active lease");
  assert.equal(final.checkpoint.history.length, 0, "Cancellation cannot invent a gate");
  assert.equal(calls, count, "Cancelling resume admission must not dispatch");
  const explicit = await sidecar.call("conductor.resume", { sessionId: session.id, runId, expectedVersion: final.index.version, launch });
  assert.equal(explicit.index.status, "running");
  const deadline = Date.now() + 15000;
  while (calls === count && Date.now() < deadline) await delay(10);
  assert.equal(calls, count + 1, "Only the explicit resume dispatches a new worker");
  assert.notEqual(identities[0].workerId, identities[1].workerId);
  assert.notEqual(identities[0].dispatchId, identities[1].dispatchId);
  assert.equal(identities[0].runId, identities[1].runId);
  const stopped = await sidecar.call("conductor.cancel", { sessionId: session.id, runId });
  assert.equal(stopped.index.status, "cancelled");
  assert.equal(stopped.checkpoint.history.length, 0);
  // Losing the host must revoke only Conductor operations, not require killing
  // the shared sidecar just to abort a held external provider request.
  const { session: lostOwner } = await host.call("session.create", { title: "Owned host loss", mode: "agent", projectPath: repo });
  const hostLoss = await sidecar.call("conductor.start", { sessionId: lostOwner.id, launch,
    request: { requestId: randomUUID(), sessionId: lostOwner.id, projectPath: repo, objective: "Observe owned host loss.", purpose: "analysis", scope: ["fixture.txt"], allowedPaths: [], excludedPaths: [], acceptanceCriteria: ["No replay."], materialPaths: [], qualityCommands: [] } });
  const hostLossDeadline = Date.now() + 15000;
  while (!identities.some(item => item.runId === hostLoss.index.runId) && Date.now() < hostLossDeadline) await delay(10);
  const hostLossWorker = identities.find(item => item.runId === hostLoss.index.runId)?.workerId;
  assert.ok(hostLossWorker, "Host-loss worker actually requested provider");
  await host.dispose();
  const abortDeadline = Date.now() + 5000;
  while (!closedWorkers.has(hostLossWorker) && Date.now() < abortDeadline) await delay(10);
  assert.ok(closedWorkers.has(hostLossWorker), "Host loss must automatically abort the existing Conductor provider connection");
  host = new HostProcess({ binaryPath: resolve(binary), dataDir: join(root, "data"), env, onStderr() {} });
  await host.call("app.handshake", { protocolVersion: 11 });
  sidecar.setHost(host);
  const hostReopened = await sidecar.call("conductor.history", { sessionId: lostOwner.id, runId: hostLoss.index.runId });
  assert.equal(hostReopened.index.status, "interrupted");
  const countAfterLoss = calls;
  await sidecar.call("conductor.history", { sessionId: lostOwner.id, runId: hostLoss.index.runId });
  assert.equal(calls, countAfterLoss);
  await sidecar.call("conductor.resume", { sessionId: lostOwner.id, runId: hostLoss.index.runId, expectedVersion: hostReopened.index.version, launch });
  const resumeDeadline = Date.now() + 15000;
  while (calls === countAfterLoss && Date.now() < resumeDeadline) await delay(10);
  assert.equal(calls, countAfterLoss + 1, "Same sidecar can explicitly resume against the replacement host");
  await sidecar.call("conductor.cancel", { sessionId: lostOwner.id, runId: hostLoss.index.runId });
  const replacement = await sidecar.call("conductor.start", { sessionId: lostOwner.id, launch,
    request: { requestId: randomUUID(), sessionId: lostOwner.id, projectPath: repo, objective: "Observe owned replacement.", purpose: "analysis", scope: ["fixture.txt"], allowedPaths: [], excludedPaths: [], acceptanceCriteria: ["No replay."], materialPaths: [], qualityCommands: [] } });
  const replacementDeadline = Date.now() + 15000;
  while (!identities.some(item => item.runId === replacement.index.runId) && Date.now() < replacementDeadline) await delay(10);
  const replacementWorker = identities.find(item => item.runId === replacement.index.runId)?.workerId;
  assert.ok(replacementWorker);
  displacedHost = host;
  host = new HostProcess({ binaryPath: resolve(binary), dataDir: join(root, "replacement-data"), env, onStderr() {} });
  await host.call("app.handshake", { protocolVersion: 11 });
  sidecar.setHost(host);
  assert.equal((await sidecar.call("conductor.availability")).available, true);
  const detachedDeadline = Date.now() + 5000;
  while (!closedWorkers.has(replacementWorker) && Date.now() < detachedDeadline) await delay(10);
  assert.ok(closedWorkers.has(replacementWorker), "Live host replacement must abort its old Conductor provider");
  assert.equal((await displacedHost.call("conductorStore.load", { sessionId: lostOwner.id, runId: replacement.index.runId })).run.status, "interrupted");
  await displacedHost.dispose();
  const { session: deletedOwner } = await host.call("session.create", { title: "Owned owner disposal", mode: "agent", projectPath: repo });
  const deleting = await sidecar.call("conductor.start", { sessionId: deletedOwner.id, launch,
    request: { requestId: randomUUID(), sessionId: deletedOwner.id, projectPath: repo, objective: "Observe owner disposal.", purpose: "analysis", scope: ["fixture.txt"], allowedPaths: [], excludedPaths: [], acceptanceCriteria: ["No surviving provider."], materialPaths: [], qualityCommands: [] } });
  const deletingDeadline = Date.now() + 15000;
  while (!identities.some(item => item.runId === deleting.index.runId) && Date.now() < deletingDeadline) await delay(10);
  const deletedWorker = identities.find(item => item.runId === deleting.index.runId)?.workerId;
  assert.ok(deletedWorker);
  await sidecar.call("agent.disposeSession", { sessionId: "other-owned-session" });
  assert.equal(closedWorkers.has(deletedWorker), false, "A different owner cannot dispose this worker");
  await host.call("session.delete", { id: deletedOwner.id });
  await sidecar.call("agent.disposeSession", { sessionId: deletedOwner.id });
  const disposedDeadline = Date.now() + 5000;
  while (!closedWorkers.has(deletedWorker) && Date.now() < disposedDeadline) await delay(10);
  assert.ok(closedWorkers.has(deletedWorker), "Owner disposal must await its Conductor provider cleanup");
  await writeFile(join(resolve(scratch), "conductor-lifecycle-result.json"), JSON.stringify({ fixtureOnly: true, desktopWiringAccepted: false,
    actualSidecarLoss: true, interruptedVersion: stored.run.version, restartProviderRequests: 0,
    cancelDuringResumeStatus: final.index.status, explicitResumeWorked: true, freshWorkerIdentity: true, hostLossAbortedProvider: true, sameSidecarExplicitResume: true, liveHostReplacementStopped: true, ownerDisposalStopped: true }, null, 2) + "\n");
  accepted = true;
  console.log("CONDUCTOR_LIFECYCLE_ACCEPTANCE_PASS: actual child loss fences lease; restart does not replay; cancelled resume cannot reactivate; no invented gate");
} finally {
  try { await sidecar?.dispose(); } catch (error) { if (accepted) throw error; console.error("Owned failed-test cleanup:", String(error)); }
  await host?.dispose();
  await displacedHost?.dispose();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
