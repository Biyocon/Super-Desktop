// Actual engine -> runtime journal -> existing Rust tool/permission executor.
// Provider reports and Gate-C consent are fixtures, NOT live/user/desktop acceptance.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, symlink, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Host } from "../../../scripts/e2e/host.mjs";
import { ConductorJournal } from "../../agent-runtime/dist/conductor/store.js";
import { drive, executionBaselineHash, parseRun } from "../dist/engine.mjs";
import { createDispatcher } from "../dist/adapter.mjs";
import { implementationRun, envelope } from "./fixtures.mjs";

const [binary, scratch] = process.argv.slice(2);
assert.ok(binary && scratch, "Explicit task-built binary and scratch required");
const root = await mkdtemp(join(resolve(scratch), "conductor-host-tools-"));
const repo = join(root, "repo"), data = join(root, "data"), home = join(root, "home");
await Promise.all([mkdir(repo), mkdir(data), mkdir(home)]);
const original = Object.fromEntries(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"].map(key => [key, process.env[key]]));
Object.assign(process.env, { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home });
const host = new Host(resolve(binary), data);
const evidence = [];
async function permission(sessionId) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const found = host.notifications.find(note => note.method === "permissions.request" && note.params.sessionId === sessionId);
    if (found) return found.params;
    await delay(5); // Bounded condition polling, never a presumed completion delay.
  }
  throw new Error("Owned permission request did not arrive");
}
try {
  await host.start();
  for (const [index, scenario] of ["allow-write", "allow-edit", "interrupt-write", "interrupt-once-write", "cancel-edit", "retarget-write"].entries()) {
    const filename = scenario === "retarget-write" ? `scope-${index}/fixture.txt` : `fixture-${index}.txt`;
    if (scenario === "retarget-write") await mkdir(join(repo, `scope-${index}`));
    await writeFile(join(repo, filename), "before\n");
    const { session } = await host.call("session.create", { title: `Owned ${scenario}`, mode: "agent", projectPath: repo });
    await host.call("session.configure", { id: session.id, mode: "agent", permissionMode: "ask" });
    const run = implementationRun({ ownerSessionId: session.id, allowedPaths: [join(repo, filename)] }, `CON-2026-${9300 + index}`);
    const runtimeId = `owned-tools-${index}`;
    const journal = await ConductorJournal.create(host, runtimeId, repo, { fixtureOnly: true }, run);
    const controller = new AbortController();
    const completed = new Error("Owned tool scenario complete; no Gate-D report accepted");
    let toolResult;
    const provider = { async dispatch(request) {
      if (request.stage !== "headsman") return envelope(request.stage, request.run);
      if (scenario.endsWith("edit")) {
        const read = await request.executeTool("read", { path: filename, file_path: filename });
        assert.equal(read.ok, true);
        toolResult = await request.executeTool("edit", { path: filename, file_path: filename, tag: read.content.tag, ops: "PUT 1.=1:\n+after" });
      } else toolResult = await request.executeTool("write", { path: filename, file_path: filename, content: "after\n" });
      throw completed;
    } };
    const pending = drive(run, createDispatcher({ workspace: repo, signal: controller.signal, provider, host: {
      journal: event => journal.append(event), validateWorkspace: async () => {}, countTokens: text => text.length,
      executeTool: (identity, signal) => journal.executeTool(identity, identity.name, identity.arguments, signal),
      runQuality: async () => { throw new Error("No quality in permission-only acceptance"); },
      resolveBaseline: async (_run, baseline) => baseline,
      authorizeExecution: async (_run, baseline, effectProfile) => ({ executionBaselineHash: executionBaselineHash(baseline), effectProfile }),
    } }), checkpoint => journal.append({ runId: run.runId, type: "checkpoint" }, checkpoint))
      .then(() => { throw new Error("Unexpected complete process"); }, error => error);
    const prompt = await permission(session.id);
    assert.equal(prompt.toolName, scenario.endsWith("edit") ? "Edit" : "Write");
    if (scenario.startsWith("interrupt")) {
      await host.call("conductorStore.interrupt", { runtimeId });
      await host.call("permissions.resolve", { requestId: prompt.requestId, decision: scenario === "interrupt-write" ? "allow-session" : "allow-once" });
      assert.match(String(await pending), /CONDUCTOR_STALE_LEASE/);
      assert.equal(await readFile(join(repo, filename), "utf8"), "before\n");
      assert.deepEqual((await host.call("permissions.listSessionGrants", { sessionId: session.id })).grants, []);
    } else if (scenario === "cancel-edit") {
      controller.abort(new Error("Owned cancel"));
      await pending;
      await assert.rejects(host.call("permissions.resolve", { requestId: prompt.requestId, decision: "allow-once" }), /NOT_FOUND|CANCELLED/);
      assert.equal(await readFile(join(repo, filename), "utf8"), "before\n");
    } else if (scenario === "retarget-write") {
      const previous = join(repo, `previous-${index}`), alternative = join(repo, `alternative-${index}`);
      await rename(join(repo, `scope-${index}`), previous);
      await mkdir(alternative);
      await writeFile(join(alternative, "fixture.txt"), "alternative\n");
      await symlink(alternative, join(repo, `scope-${index}`), "junction");
      await host.call("permissions.resolve", { requestId: prompt.requestId, decision: "allow-once" });
      assert.match(String(await pending), /CONDUCTOR_SCOPE_CHANGED/);
      assert.equal(await readFile(join(alternative, "fixture.txt"), "utf8"), "alternative\n");
      assert.equal(await readFile(join(previous, "fixture.txt"), "utf8"), "before\n");
    } else {
      await host.call("permissions.resolve", { requestId: prompt.requestId, decision: "allow-once" });
      assert.equal(await pending, completed);
      assert.equal(toolResult.ok, true);
      assert.equal(await readFile(join(repo, filename), "utf8"), "after\n");
    }
    if (!scenario.startsWith("allow")) {
      const snapshots = await readdir(join(data, "review-changes", session.id)).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      assert.deepEqual(snapshots, [], "Rejected/cancelled tools must discard owned review snapshots");
    }
    const loaded = await host.call("conductorStore.load", { sessionId: session.id, runId: run.runId });
    const checkpoint = parseRun(typeof loaded.checkpoint === "string" ? loaded.checkpoint : JSON.stringify(loaded.checkpoint));
    assert.deepEqual(checkpoint.history.map(gate => gate.gate), ["A", "B", "C"], "No tool outcome fabricates a Gate-D pass");
    evidence.push({ scenario, passed: true, history: ["A", "B", "C"] });
  }
  {
    const { session } = await host.call("session.create", { title: "Owned intake Read cancellation", mode: "agent", projectPath: repo });
    await host.call("session.configure", { id: session.id, mode: "agent", permissionMode: "ask" });
    const external = join(root, "owned-external.txt"), toolCallId = randomUUID();
    await writeFile(external, "Owned external permission fixture only.\n");
    const pending = host.call("tools.execute", { sessionId: session.id, toolCallId, toolName: "Read",
      args: { path: external }, mode: "agent", permissionScope: "inherit" }).catch(error => error);
    const prompt = await permission(session.id);
    assert.equal(prompt.toolName, "Read");
    await host.call("tools.abort", { sessionId: session.id, toolCallId });
    assert.equal((await pending).errorCode, "TOOL_ABORTED");
    await assert.rejects(host.call("permissions.resolve", { requestId: prompt.requestId, decision: "allow-session" }), /NOT_FOUND|CANCELLED/);
    assert.deepEqual((await host.call("permissions.listSessionGrants", { sessionId: session.id })).grants, []);
    evidence.push({ scenario: "cancel-intake-read", passed: true, history: [] });
  }
  await writeFile(join(resolve(scratch), "conductor-host-tools-result.json"), JSON.stringify({ fixtureOnly: true, desktopWiringAccepted: false,
    actualHostPermissions: true, scenarios: evidence }, null, 2) + "\n");
  console.log("CONDUCTOR_HOST_TOOLS_ACCEPTANCE_PASS: actual Write/Edit permissions; late approval after interruption denied; cancellation settled; no invented Gate D");
} finally {
  await host.stop();
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true });
}
