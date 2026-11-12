// Actual bundler refusal before overwriting a task-owned hardlinked output.
// Run serially with bundling: this temporarily replaces only its own ignored file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [scratch] = process.argv.slice(2);
assert.ok(scratch, "Explicit owned scratch required");
const root = await mkdtemp(join(resolve(scratch), "conductor-bundle-output-"));
const output = fileURLToPath(new URL("../../agent-runtime/dist-bundle/service.js", import.meta.url));
const script = fileURLToPath(new URL("../../agent-runtime/bundle-conductor.mjs", import.meta.url));
const original = await readFile(output);
assert.equal((await lstat(output)).nlink, 1, "Only our ordinary isolated output may be replaced");
const canary = join(root, "owned-canary.txt"), bytes = Buffer.from("owned output must not be overwritten\n");
await writeFile(canary, bytes, { flag: "wx" });
let linked = false;
try {
  await unlink(output);
  await link(canary, output); linked = true;
  const result = spawnSync(process.execPath, [script], { shell: false, windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CONDUCTOR_BUNDLE_PATH_INVALID/);
  assert.deepEqual(await readFile(canary), bytes);
  console.log("CONDUCTOR_BUNDLE_OUTPUT_ACCEPTANCE_PASS: actual bundler rejected an individual hardlink; own canary unchanged");
} finally {
  if (linked) {
    const [actual, expected] = await Promise.all([lstat(output), lstat(canary)]);
    assert.equal(actual.ino, expected.ino, "Unexpected replacement: do not delete a changed path");
    assert.equal(actual.dev, expected.dev);
    await unlink(output);
  }
  await writeFile(output, original, { flag: "wx" });
  await rm(root, { recursive: true, force: true });
}
