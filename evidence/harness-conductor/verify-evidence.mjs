import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const folder = dirname(fileURLToPath(import.meta.url));
const root = resolve(folder, "../..");
const text = readFileSync(resolve(folder, "candidate.json"), "utf8");
const receipt = JSON.parse(text);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
assert.equal(receipt.format, 1);
assert.equal(receipt.fixtureOnly, true);
assert.equal(receipt.liveModelAccepted, false);
assert.equal(receipt.nativeElectronAccepted, true);
assert.equal(receipt.passed, true);
assert.equal(receipt.uncommittedCandidate, false);
assert.equal(receipt.concurrentCandidateChange, false);
assert.equal(receipt.ownedRuntimeRemoved, true);
assert.doesNotMatch(text, /[A-Z]:[\\/]Users[\\/]|\/Users\/|\/home\//i);
for (const [commit, tree] of [[receipt.testedCommit, receipt.testedTree], [receipt.baseCommit, receipt.baseTree]]) {
  assert.equal(git("rev-parse", `${commit}^{tree}`), tree);
}
execFileSync("git", ["merge-base", "--is-ancestor", receipt.baseCommit, receipt.testedCommit], { cwd: root });
// Documentation/evidence can follow the tested commit; executable source cannot.
assert.equal(git("diff", "--name-only", receipt.testedCommit, "HEAD", "--", "apps", "packages", "crates", "scripts", "Cargo.toml", "Cargo.lock", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "biome.json", ".cargo"), "");
for (const record of [receipt.rendererReload, receipt.fullAppRelaunch]) {
  assert.deepEqual(record, { historyIdentical: true, providerReplay: 0, writeReplay: 0, dispatchReplay: 0 });
}
assert.deepEqual(receipt.runs.map(run => run.purpose), ["analysis", "implementation"]);
assert.ok(receipt.runs.every(run => /^CON-\d{4}-\d{4}$/.test(run.runId) && run.externalActionAuthorized === false));
assert.equal(Object.keys(receipt.screenshotSha256).length, receipt.counts.screenshots);
for (const value of Object.values(receipt.screenshotSha256)) assert.match(value, /^[a-f0-9]{64}$/);
assert.equal(receipt.counts.faults, 0);

if (process.argv[2]) {
  const bytes = readFileSync(resolve(process.argv[2]));
  assert.equal(hash(bytes), receipt.privateRawReceiptSha256);
  const raw = JSON.parse(bytes);
  for (const field of ["fixtureOnly", "liveModelAccepted", "nativeElectronAccepted", "passed", "uncommittedCandidate", "concurrentCandidateChange"]) assert.equal(raw[field], receipt[field]);
  assert.equal(raw.sourceAtStart.head, receipt.testedCommit);
  assert.equal(raw.sourceAtStart.base, receipt.baseCommit);
  assert.equal(raw.sourceAtStart.status, "");
  assert.equal(raw.sourceAtStart.sourceHash, receipt.sourceMapSha256);
  assert.equal(raw.requests.length, receipt.counts.loopbackProviderRequests);
  assert.equal(raw.interactions.length, receipt.counts.nativeDisclosureInteractions);
  assert.equal(raw.permissionAnswers.length, receipt.counts.separateWriteAllowOnce);
  assert.equal(raw.networkGuard.ownedChildren, receipt.counts.ownedChildrenObservedExitedOrAbsent);
  assert.equal(raw.faults.length, receipt.counts.faults);
  assert.deepEqual(raw.screenshots, receipt.screenshotSha256);
  for (const record of ["renderer-reload", "full-app-relaunch"]) {
    const { kind, ...outcome } = raw.outcomes.find(row => row.kind === record);
    assert.deepEqual(outcome, record === "renderer-reload" ? receipt.rendererReload : receipt.fullAppRelaunch);
  }
  for (const [path, value] of Object.entries(receipt.buildSha256)) {
    const observed = raw.sourceAtStart.builtHashes[path === "owned-host-binary" ? raw.hostBinary : resolve(root, path)];
    assert.equal(observed, value, path);
  }
  assert.equal(existsSync(resolve(raw.root, "owned")), false);
}
console.log("HARNESS_CANDIDATE_EVIDENCE_PASS: exact source/base trees, native receipt, no replay, no private paths; not live-model acceptance");
