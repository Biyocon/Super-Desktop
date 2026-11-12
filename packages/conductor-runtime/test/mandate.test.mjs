import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureMandate } from "../src/mandate.mjs";
import { createQualityCatalog } from "../src/quality-catalog.mjs";
import { implementationRun } from "./fixtures.mjs";

const definition = { id: "verify", image: `sha256:${"a".repeat(64)}`, argv: ["/usr/local/bin/node", "verify.mjs"],
  requiredGates: ["D", "E"], timeoutMs: 10000, outputLimitBytes: 8192 };
const catalog = createQualityCatalog([definition]);
const input = { owner: "fixture-user", objective: "Verify the authoritative driver.", purpose: "implementation", scope: ["owned fixture"],
  allowedPaths: ["src"], excludedPaths: ["src/private"], qualityCommandIds: ["verify"], sourceBaseline: "owned-source-v1" };
const proposal = { scopeVersion: "s1", planVersion: "p1", acceptanceVersion: "a1", rollbackReference: input.sourceBaseline, qualityCommandIds: ["verify"] };
function runFor(mandate) {
  const snapshot = mandate.snapshot();
  return implementationRun({ authority: { owner: snapshot.owner }, objective: snapshot.objective, scope: snapshot.scope,
    allowedPaths: snapshot.allowedPaths, excludedPaths: snapshot.excludedPaths, sourceBaseline: snapshot.sourceBaseline });
}
function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "conductor-mandate-"));
  try { mkdirSync(join(root, "src")); return callback(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("host mandate freezes canonical scope and required quality without granting tool authority", () => fixture(root => {
  const mandate = captureMandate(root, input, catalog);
  const run = runFor(mandate);
  mandate.validate(run);
  const baseline = mandate.resolveBaseline(run, proposal);
  assert.deepEqual(baseline.allowedPaths, run.allowedPaths);
  assert.deepEqual(baseline.qualityCommands, catalog.bindings());
  assert.equal(run.executionAuthorization, null);
  const detached = mandate.snapshot(); detached.allowedPaths.push("untrusted");
  assert.equal(mandate.snapshot().allowedPaths.length, 1);
  for (const changed of [{ ...run, authority: { owner: "another-owner" } }, { ...run, allowedPaths: [root] },
    { ...run, sourceBaseline: "different" }, { ...run, objective: "expanded task" }]) {
    assert.throws(() => mandate.validate(changed), /MANDATE_CHANGED/);
  }
  assert.throws(() => mandate.resolveBaseline(run, { ...proposal, qualityCommandIds: [] }));
  assert.throws(() => mandate.resolveBaseline(run, { ...proposal, allowedPaths: [root] }));
  assert.throws(() => mandate.resolveBaseline(run, { ...proposal, rollbackReference: "wrong-baseline" }), /SCOPE_CHANGED/);
}));

test("analysis cannot acquire write scope or catalog execution", () => fixture(root => {
  assert.throws(() => captureMandate(root, { ...input, purpose: "analysis" }, catalog), /ANALYSIS_MUTATION_DENIED/);
  const analysis = captureMandate(root, { ...input, purpose: "analysis", allowedPaths: [], qualityCommandIds: [] }, catalog);
  assert.deepEqual(analysis.snapshot().allowedPaths, []);
  assert.deepEqual(analysis.snapshot().qualityCommands, []);
}));

test("read-only analysis admits an empty catalog but implementation still requires D/E bindings", () => fixture(root => {
  const empty = createQualityCatalog([]);
  assert.deepEqual(empty.bindings(), []);
  assert.deepEqual(captureMandate(root, { ...input, purpose: "analysis", allowedPaths: [], qualityCommandIds: [] }, empty).snapshot().qualityCommands, []);
  assert.throws(() => captureMandate(root, { ...input, qualityCommandIds: [] }, empty));
}));

test("scope traversal, Git metadata, wildcard, root and incomplete verification are denied", () => fixture(root => {
  for (const path of ["../outside", ".git/config", "src/.GIT/config", "src/*", ".", root]) {
    assert.throws(() => captureMandate(root, { ...input, allowedPaths: [path] }, catalog));
  }
  assert.throws(() => captureMandate(root, input, createQualityCatalog([{ ...definition, requiredGates: ["D"] }])), /QUALITY_GATES_MISSING/);
}));

test("retargeted directory links invalidate the captured scope", () => fixture(root => {
  mkdirSync(join(root, "first")); mkdirSync(join(root, "second"));
  const link = join(root, "linked");
  symlinkSync(join(root, "first"), link, process.platform === "win32" ? "junction" : "dir");
  const mandate = captureMandate(root, { ...input, allowedPaths: ["linked"] }, catalog);
  const run = runFor(mandate);
  mandate.validate(run);
  rmSync(link, { recursive: true });
  symlinkSync(join(root, "second"), link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => mandate.validate(run), /SCOPE_CHANGED/);
}));
