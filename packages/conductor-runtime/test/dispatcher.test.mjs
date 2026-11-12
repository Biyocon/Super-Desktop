import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drive, executionBaselineHash } from "../dist/engine.mjs";
import { createDispatcher } from "../src/dispatcher.mjs";
import { implementationRun, envelope, dispatcher as fixtureDispatcher } from "./fixtures.mjs";

function services(root, events) {
  return {
    journal: async event => events.push(event),
    validateWorkspace: async () => {},
    countTokens: text => Buffer.byteLength(text),
    authorizeExecution: async (_run, baseline, effectProfile) => ({ executionBaselineHash: executionBaselineHash(baseline), effectProfile }),
    resolveBaseline: async (run, proposal) => ({ ...proposal, allowedPaths: run.allowedPaths, excludedPaths: run.excludedPaths, qualityCommands: [] }),
    executeTool: async request => {
      assert.equal(request.name, "write");
      const target = join(root, request.arguments.file_path);
      assert.equal(target, join(root, "fixture.txt"));
      writeFileSync(target, request.arguments.content);
      return { status: "written" };
    },
    runQuality: async () => { throw new Error("No quality command is admitted in this focused test"); },
  };
}

test("dispatcher retains separate worker identity, applies guard, performs owned write and revokes tool callback", async () => {
  const root = mkdtempSync(join(tmpdir(), "conductor-dispatch-"));
  const events = [], calls = [];
  let retained;
  try {
    writeFileSync(join(root, "fixture.txt"), "before");
    const host = services(root, events);
    const provider = { dispatch: async request => {
      calls.push({ role: request.stage, workerId: request.workerId, dispatchId: request.dispatchId });
      // Mutating the provider's copy must not change engine authority.
      request.run.authority.owner = "untrusted-provider";
      if (request.stage === "headsman") {
        await assert.rejects(request.executeTool("write", { file_path: "../outside.txt", content: "denied" }), /CONDUCTOR_TOOL_DENIED/);
        await request.executeTool("write", { file_path: "fixture.txt", content: "after" });
        retained = request.executeTool;
      } else {
        await assert.rejects(request.executeTool("write", { file_path: "fixture.txt", content: "denied" }), /CONDUCTOR_TOOL_DENIED/);
      }
      return request.stage === "arbiter" ? fixtureDispatcher().dispatchArbiter(request.run) : envelope(request.stage, request.run);
    } };
    const run = implementationRun();
    const result = await drive(run, createDispatcher({ host, provider, workspace: root, signal: new AbortController().signal }));
    assert.equal(result.kind, "decision");
    assert.equal(result.run.authority.owner, "fixture-user");
    assert.equal(readFileSync(join(root, "fixture.txt"), "utf8"), "after");
    assert.equal(new Set(calls.map(call => call.workerId)).size, 7);
    assert.equal(new Set(calls.map(call => call.dispatchId)).size, 7);
    assert.equal(events.filter(event => event.type === "dispatch-start").length, 7);
    assert.equal(events.filter(event => event.type === "dispatch-end" && event.status === "completed").length, 7);
    await assert.rejects(retained("write", { file_path: "fixture.txt", content: "late write" }), /CONDUCTOR_DISPATCH_CLOSED/);
    assert.equal(readFileSync(join(root, "fixture.txt"), "utf8"), "after");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing durable start acknowledgement prevents provider execution", async () => {
  let called = false;
  const host = services("unused", []);
  host.journal = async () => { throw new Error("storage unavailable"); };
  const adapter = createDispatcher({ host, provider: { dispatch: async () => { called = true; } }, workspace: "unused", signal: new AbortController().signal });
  await assert.rejects(drive(implementationRun(), adapter), /storage unavailable/);
  assert.equal(called, false);
});

test("cancelled dispatch revokes capabilities and does not create a gate pass", async () => {
  const controller = new AbortController(), events = [];
  let retained;
  const run = implementationRun();
  const provider = { dispatch: async request => {
    retained = request.executeTool;
    controller.abort(new Error("fixture cancellation"));
    return envelope(request.stage, request.run);
  } };
  await assert.rejects(drive(run, createDispatcher({ host: services("unused", events), provider, workspace: "unused", signal: controller.signal })), /fixture cancellation/);
  assert.deepEqual(run.history, []);
  assert.equal(events.at(-1).status, "cancelled");
  await assert.rejects(retained("read", {}), /fixture cancellation/);
});

test("provider ignoring cancellation cannot keep dispatch alive or submit late evidence", async () => {
  const controller = new AbortController(), events = [];
  const started = Promise.withResolvers(), response = Promise.withResolvers();
  let retained;
  const run = implementationRun();
  const provider = { dispatch: request => { retained = request; started.resolve(); return response.promise; } };
  const pending = drive(run, createDispatcher({ host: services("unused", events), provider, workspace: "unused", signal: controller.signal }));
  await started.promise;
  const assertion = assert.rejects(pending, /cancel ignoring provider/);
  controller.abort(new Error("cancel ignoring provider"));
  await assertion;
  response.resolve(envelope("detective", run));
  await assert.rejects(retained.executeTool("write", { file_path: "fixture.txt", content: "late" }), /cancel ignoring provider/);
  assert.deepEqual(run.history, []);
  assert.equal(events.filter(event => event.type === "dispatch-end").length, 1);
  assert.equal(events.at(-1).status, "cancelled");
});

test("cancellation acknowledgement waits for dispatch-owned host operation cleanup", async () => {
  const controller = new AbortController(), events = [], started = Promise.withResolvers();
  let cleaned = false;
  const host = services("unused", events);
  host.executeTool = (_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { cleaned = true; reject(signal.reason); }, { once: true });
    started.resolve();
  });
  const provider = { dispatch: request => {
    void request.executeTool("read", { file_path: "fixture.txt" }).catch(() => {});
    return new Promise(() => {});
  } };
  const pending = drive(implementationRun(), createDispatcher({ host, provider, workspace: "unused", signal: controller.signal }));
  await started.promise;
  const assertion = assert.rejects(pending, /owned cleanup cancellation/);
  controller.abort(new Error("owned cleanup cancellation"));
  await assertion;
  assert.equal(cleaned, true);
  assert.equal(events.at(-1).status, "cancelled");
});
