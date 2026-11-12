import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { createQualityCatalog, sha256 } from "../src/quality-catalog.mjs";
import { createQualityRunner } from "../src/quality-runner.mjs";
import { createDispatcher } from "../src/dispatcher.mjs";
import { drive, executionBaselineHash, parseRun, serializeRun } from "../dist/engine.mjs";
import { implementationRun, envelope, dispatcher as fixtureDispatcher } from "./fixtures.mjs";
import { localContainerResources } from "./local-container-resources.mjs";

const [dockerExecutable, image, scratchRoot] = process.argv.slice(2);
assert.ok(dockerExecutable && image && scratchRoot, "Explicit cached docker executable, image id and owned scratch root required");
const root = await mkdtemp(join(scratchRoot, "conductor-quality-acceptance-"));
const events = [], snapshots = [];
let headsmanRequest;
try {
  await chmod(root, 0o755);
  await writeFile(join(root, "fixture.txt"), "before\n");
  await writeFile(join(root, "verify.mjs"), `import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.equal(fs.readFileSync('fixture.txt', 'utf8'), 'after\\n');
assert.throws(() => fs.writeFileSync('fixture.txt', 'denied'), { code: 'EROFS' });
console.log('ACTUAL_CHANGE_VERIFIED');\n`);
  const catalog = createQualityCatalog([{ id: "verify-fixture", image, argv: ["/usr/local/bin/node", "verify.mjs"],
    requiredGates: ["D", "E"], timeoutMs: 15000, outputLimitBytes: 8192 }]);
  const validateWorkspace = async () => { assert.equal(await readFile(join(root, "verify.mjs"), "utf8").then(sha256), verifierHash); };
  const verifierHash = sha256(await readFile(join(root, "verify.mjs")));
  const runQuality = createQualityRunner({ dockerExecutable, workspace: root, catalog, validateWorkspace, resources: localContainerResources(dockerExecutable, scratchRoot, root, catalog) });
  const host = {
    validateWorkspace, countTokens: text => Buffer.byteLength(text), journal: async event => { events.push(event); },
    authorizeExecution: async (_run, baseline, effectProfile) => ({ executionBaselineHash: executionBaselineHash(baseline), effectProfile }),
    resolveBaseline: async (run, proposal) => ({ ...proposal, allowedPaths: run.allowedPaths, excludedPaths: run.excludedPaths, qualityCommands: catalog.resolve(["verify-fixture"]) }),
    executeTool: async request => {
      assert.equal(request.stage, "headsman"); assert.equal(request.name, "write"); assert.equal(request.arguments.file_path, "fixture.txt");
      await writeFile(join(root, "fixture.txt"), request.arguments.content);
      return { status: "written" };
    }, runQuality,
  };
  const provider = { dispatch: async request => {
    if (request.stage === "headsman") headsmanRequest = structuredClone(request.run);
    if (request.stage === "arbiter") return fixtureDispatcher().dispatchArbiter(request.run);
    const output = envelope(request.stage, request.run);
    if (request.stage === "headsman") await request.executeTool("write", { file_path: "fixture.txt", content: "after\n" });
    for (const binding of request.requiredQualityCommands) {
      const checked = await request.quality(binding.id);
      assert.equal(checked.outcome, "passed", checked.stderr);
      assert.match(checked.stdout, /ACTUAL_CHANGE_VERIFIED/);
      output.quality_evidence_ids.push(checked.evidenceId);
      output.evidence.push({ kind: "test", reference: checked.evidenceId, outcome: checked.stdout.trim() });
    }
    return output;
  } };
  const result = await drive(implementationRun(), createDispatcher({ host, provider, workspace: root, signal: new AbortController().signal }),
    async snapshot => { snapshots.push(parseRun(serializeRun(snapshot))); });
  assert.equal(result.kind, "decision");
  assert.equal(result.run.status, "awaiting_authorization");
  assert.deepEqual(result.run.history.map(item => item.gate), ["A", "B", "C", "D", "E", "F", "G"]);
  const quality = result.run.qualityExecutions;
  assert.equal(quality.length, 2);
  assert.deepEqual(quality.map(item => item.gate), ["D", "E"]);
  assert.equal(new Set(quality.map(item => item.childSessionId)).size, 2);
  assert.equal(new Set(quality.map(item => item.evidenceId)).size, 2);
  assert.ok(quality.every(item => item.outcome === "passed" && item.stdoutSha256 === sha256("ACTUAL_CHANGE_VERIFIED\n")));
  assert.equal(await readFile(join(root, "fixture.txt"), "utf8"), "after\n");
  let failedCheckpoint;
  const failingProvider = { dispatch: async request => {
    const output = await provider.dispatch(request);
    if (request.stage === "headsman") throw new Error("owned failure after actual quality");
    return output;
  } };
  await assert.rejects(drive(implementationRun({}, "CON-2026-9002"), createDispatcher({ host, provider: failingProvider, workspace: root, signal: new AbortController().signal }),
    async checkpoint => { failedCheckpoint = parseRun(serializeRun(checkpoint)); }), /owned failure after actual quality/);
  assert.equal(failedCheckpoint.qualityExecutions.length, 0, "unjudged execution stays in the host journal, not accepted engine history");
  const unjudged = events.filter(event => event.runId === "CON-2026-9002" && event.type === "quality-result");
  assert.equal(unjudged.length, 1);
  assert.equal(unjudged[0].record.gate, "D");
  assert.equal(unjudged[0].record.outcome, "passed");
  assert.equal(events.findLast(event => event.runId === "CON-2026-9002" && event.type === "dispatch-end").status, "failed");
  assert.deepEqual(failedCheckpoint.history.map(item => item.gate), ["A", "B", "C"]);
  // These are OS-boundary negatives, not fabricated accepted engine checkpoints.
  const negatives = [];
  for (const [id, code, timeoutMs, expected] of [
    ["nonzero", "process.exit(7)", 10000, "nonzero-exit"],
    ["overflow", "process.stdout.write('x'.repeat(20000))", 10000, undefined],
    ["timeout", "setInterval(() => {}, 1000)", 500, "timeout"],
  ]) {
    const negativeCatalog = createQualityCatalog([{ id, image, argv: ["/usr/local/bin/node", "-e", code], requiredGates: ["D"], timeoutMs, outputLimitBytes: 256 }]);
    const negativeRun = structuredClone(headsmanRequest);
    negativeRun.baseline.qualityCommands = negativeCatalog.bindings();
    negativeRun.executionAuthorization.executionBaselineHash = executionBaselineHash(negativeRun.baseline);
    const runner = createQualityRunner({ dockerExecutable, workspace: root, catalog: negativeCatalog, validateWorkspace, resources: localContainerResources(dockerExecutable, scratchRoot, root, negativeCatalog) });
    const checked = await runner({ run: negativeRun, runId: negativeRun.runId, workerId: "negative-worker", dispatchId: id, stage: "headsman", gate: "D", cycle: 1,
      binding: negativeCatalog.bindings()[0] }, new AbortController().signal);
    assert.equal(checked.record.failure, expected);
    assert.equal(checked.record.outcome, expected ? "failed" : "passed");
    if (id === "overflow") {
      assert.equal(checked.record.stdoutTruncated, true);
      assert.equal(checked.output.stdout.length, 256);
      assert.equal(checked.record.stdoutSha256, sha256("x".repeat(20000)));
    }
    for (const name of checked.execution.containerNames) {
      const dockerHost = process.platform === "win32" ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock";
      const inspected = spawnSync(dockerExecutable, ["--config", root, "--host", dockerHost, "inspect", name], { encoding: "utf8", shell: false, windowsHide: true });
      assert.equal(inspected.status, 1);
      assert.match(inspected.stderr, new RegExp(`no such (object|container): ${name}`, "i"));
    }
    negatives.push({ id, outcome: checked.record.outcome, failure: checked.record.failure, containersRemoved: true });
  }
  assert.ok(snapshots.length > 0);
  const summary = { fixtureOnly: true, desktopWiringAccepted: false, gates: result.run.history.map(item => item.gate),
    status: result.run.status, quality, negatives, dispatches: events.filter(event => event.type === "dispatch-start").map(({ stage, workerId, dispatchId }) => ({ stage, workerId, dispatchId })) };
  await writeFile(join(scratchRoot, "conductor-quality-acceptance-result.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log("CONDUCTOR_QUALITY_ACCEPTANCE_PASS: actual A-G driver; owned change; independent real D/E verification; confined read-only repo; no release authority");
} finally {
  await rm(root, { recursive: true, force: true });
}
