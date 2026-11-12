// Real motor + runtime journal + Rust RPC acceptance. Provider output is a
// motor-contract fixture; this is NOT desktop or real-change acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Host } from "../../../scripts/e2e/host.mjs";
import { ConductorJournal, loadConductorRun } from "../../agent-runtime/dist/conductor/store.js";
import { drive, parseRun, serializeRun, admitIntake, captureIntakeMaterial, executionBaselineHash } from "../dist/engine.mjs";
import { createDispatcher } from "../dist/adapter.mjs";
import { implementationRun, envelope, dispatcher as fixtureDispatcher } from "./fixtures.mjs";

const [binary, scratch] = process.argv.slice(2);
assert.ok(binary && scratch, "Explicit task-built host binary and scratch root required");
const root = await mkdtemp(join(resolve(scratch), "conductor-host-store-"));
const repo = join(root, "repo"), data = join(root, "data"), home = join(root, "home");
await Promise.all([mkdir(repo), mkdir(data), mkdir(home)]);
await writeFile(join(repo, "fixture.txt"), "unchanged\n");
const digest = async () => createHash("sha256").update(await readFile(join(repo, "fixture.txt"))).digest("hex");
const source = await digest();
const original = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home });
const host = new Host(resolve(binary), data);
const calls = [];
const transport = { async call(method, params) { calls.push(method); return host.call(method, params); } };
try {
  await host.start();
  const { session } = await host.call("session.create", { title: "Owned Conductor store fixture", projectPath: repo });
  const run = implementationRun({ ownerSessionId: session.id,
    admission: admitIntake({ purpose: "implementation", entry: "detective", rationale: "Host persistence fixture only." }, [
      captureIntakeMaterial("current-request", "Persist and reopen this owned motor-contract fixture.", { sessionId: session.id, eventIndex: 0 }),
    ]),
  });
  let journal = await ConductorJournal.create(transport, "owned-runtime-one", repo, { fixtureOnly: true, source }, run);
  const stages = [];
  const provider = { async dispatch(request) {
    stages.push(request.stage);
    return request.stage === "arbiter" ? fixtureDispatcher().dispatchArbiter(request.run) : envelope(request.stage, request.run);
  } };
  const services = () => ({ journal: event => journal.append(event),
    validateWorkspace: async () => assert.equal(await digest(), source), countTokens: text => text.length,
    executeTool: async () => { throw new Error("No workspace tool in store-only fixture"); },
    runQuality: async () => { throw new Error("No quality execution in store-only fixture"); },
    resolveBaseline: async (_run, baseline) => baseline,
    authorizeExecution: async (_run, baseline, effectProfile) => ({ executionBaselineHash: executionBaselineHash(baseline), effectProfile }),
  });
  const cancellation = new Error("owned fixture interruption after committed A");
  await assert.rejects(drive(run, createDispatcher({ host: services(), provider, workspace: repo, signal: new AbortController().signal }), async checkpoint => {
    parseRun(serializeRun(checkpoint));
    await journal.append({ runId: run.runId, type: "checkpoint" }, checkpoint);
    throw cancellation;
  }), error => error === cancellation);
  assert.deepEqual(stages, ["detective"]);
  const before = await loadConductorRun(transport, session.id, run.runId);
  assert.equal(before.checkpoint.currentStage, "strategist");
  assert.deepEqual(before.checkpoint.history.map(item => item.gate), ["A"]);
  const versionBeforeRead = before.index.version;
  const methodsBeforeRead = calls.length;
  await loadConductorRun(transport, session.id, run.runId);
  assert.deepEqual(calls.slice(methodsBeforeRead), ["conductorStore.load"]);
  assert.equal((await loadConductorRun(transport, session.id, run.runId)).index.version, versionBeforeRead);
  await host.restart();
  const loaded = await loadConductorRun(transport, session.id, run.runId);
  assert.equal(loaded.index.status, "interrupted");
  assert.deepEqual(loaded.checkpoint, before.checkpoint);
  assert.deepEqual(stages, ["detective"], "host restart and load must not call provider");
  await assert.rejects(journal.append({ runId: run.runId, type: "late" }), /CONDUCTOR_STALE_LEASE/);
  let baselineChecks = 0;
  await assert.rejects(ConductorJournal.resume(transport, "owned-runtime-two", loaded, async () => { throw new Error("source changed"); }), /source changed/);
  assert.equal((await loadConductorRun(transport, session.id, run.runId)).index.status, "interrupted");
  journal = await ConductorJournal.resume(transport, "owned-runtime-two", loaded, async () => { assert.equal(await digest(), source); baselineChecks++; });
  const result = await drive(loaded.checkpoint, createDispatcher({ host: services(), provider, workspace: repo, signal: new AbortController().signal }), async checkpoint => {
    await journal.append({ runId: run.runId, type: "checkpoint" }, checkpoint);
  });
  await journal.append({ runId: run.runId, type: "outcome", kind: result.kind }, result.run, "completed");
  assert.equal(baselineChecks, 1);
  assert.deepEqual(stages, ["detective", "strategist", "devils-advocate", "headsman", "auditor", "integrator", "arbiter"]);
  assert.equal(result.run.status, "awaiting_authorization", "GO is not release permission");
  assert.deepEqual(result.run.history.map(item => item.gate), ["A", "B", "C", "D", "E", "F", "G"]);
  const events = await host.call("conductorStore.events", { sessionId: session.id, runId: run.runId });
  const starts = events.events.filter(item => item.payload.event.type === "dispatch-start");
  assert.equal(starts.length, 7);
  assert.equal(new Set(starts.map(item => item.payload.event.workerId)).size, 7);
  await host.restart();
  const completed = await loadConductorRun(transport, session.id, run.runId);
  assert.equal(completed.index.status, "completed");
  assert.deepEqual(completed.checkpoint, result.run);
  assert.equal(await digest(), source);
  const report = { fixtureOnly: true, desktopWiringAccepted: false, realChangeAccepted: false,
    hostRuntimeEnginePersistence: true, stages, distinctWorkers: starts.length,
    noDispatchOnLoadOrRestart: true, staleLeaseRejected: true, baselineRejectionBeforeResume: true,
    engineStatus: completed.checkpoint.status, hostStatus: completed.index.status };
  await writeFile(join(resolve(scratch), "conductor-host-store-result.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("CONDUCTOR_HOST_STORE_ACCEPTANCE_PASS: real engine/runtime journal/Rust RPC; restart fences lease; explicit resume B-G; no replay");
} finally {
  await host.stop();
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true });
}
