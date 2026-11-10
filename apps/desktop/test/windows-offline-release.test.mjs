import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const files = ["package.json", "Cargo.toml", "Cargo.lock", "packages/shared/src/protocol.ts", "apps/desktop/resources/models.dev/api.json"];
const snapshot = () => files.map(path => createHash("sha256").update(readFileSync(join(repo,path))).digest("hex"));
for (const args of [["0.15.7", "--offline"], ["0.15.7-super.1", "--offline", "--tag"]]) {
  test(`offline preparation rejects unsafe mode before writes: ${args.join(" ")}`, () => {
    const before = snapshot();
    const result = spawnSync(process.execPath,["scripts/release.mjs",...args],{cwd:repo,encoding:"utf8"});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/--offline is only for local prerelease preparation without --tag/);
    assert.deepEqual(snapshot(),before);
  });
}
