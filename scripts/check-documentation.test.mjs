import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("..", import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kombi-docs-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const p of ["scripts/check-documentation.mjs", ".agents/docs/tools/docctl.mjs", ".agents/docs/tools/install.json", ".agents/docs/tools/THIRD-PARTY-NOTICES"]) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.copyFileSync(path.join(repo, p), path.join(root, p));
  }
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/a.md"), "# Architecture\n\nCurrent documented behavior.\n");
  fs.writeFileSync(path.join(root, ".agents/docs/config.json"), JSON.stringify({
    schemaVersion: 1, repositoryId: "gate-test", documents: ["docs"],
    roles: { architecture: "docs/a.md" }, requiredRoles: ["architecture"],
  }));
  return root;
}
function run(root, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(root, "scripts/check-documentation.mjs"), ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, CI: "", DOCS_BASE_REF: "", ...env }, windowsHide: true,
  });
}
function commit(root) {
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "docs/a.md", ".agents/docs/config.json"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
}
test("local gate blocks a new broken document link", (t) => {
  const root = fixture(t);
  assert.equal(run(root).status, 0);
  fs.appendFileSync(path.join(root, "docs/a.md"), "\n[broken](missing.md)\n");
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DOC002/);
});
test("CI requires an available trusted base and verifies the pinned tool", (t) => {
  const root = fixture(t);
  assert.equal(run(root, [], { CI: "true" }).status, 2);
  commit(root);
  assert.equal(run(root, [], { CI: "true", DOCS_BASE_REF: "missing-base" }).status, 2);
  assert.equal(run(root, [], { CI: "true", DOCS_BASE_REF: "HEAD" }).status, 0);
  fs.appendFileSync(path.join(root, ".agents/docs/tools/docctl.mjs"), "\n// local mutation\n");
  assert.equal(run(root).status, 2);
});
test("CI rejects an unrecorded baseline expansion", (t) => {
  const root = fixture(t); commit(root);
  fs.appendFileSync(path.join(root, "docs/a.md"), "\n[broken](missing.md)\n");
  const baseline = spawnSync(process.execPath, [path.join(root, ".agents/docs/tools/docctl.mjs"), "baseline", root, "--reason", "Test old debt", "--revision", "HEAD", "--out", path.join(root, "review.json")], { encoding: "utf8" });
  assert.equal(baseline.status, 0, baseline.stderr);
  fs.copyFileSync(path.join(root, "review.json"), path.join(root, ".agents/docs/baseline.json"));
  assert.equal(run(root).status, 0);
  const result = run(root, [], { CI: "true", DOCS_BASE_REF: "HEAD" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BASE001/);
});
test("unresolved audit observations cannot silently pass the project gate", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "docs/a.md"), "# Architecture\n\nUnknown — confirm from source.\n");
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /confirm from source/);
});
