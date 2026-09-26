import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const importer = fileURLToPath(
  new URL("../../../scripts/import-customagents.mjs", import.meta.url),
);

function profile({ id, role = "Test specialist" } = {}) {
  return [
    "---",
    ...(id ? [`id: ${id}`] : []),
    `role: ${role}`,
    'description: "Test profile"',
    "---",
    "",
    "## System Prompt",
    "```text",
    `You are the ${role}.`,
    "```",
    "",
  ].join("\n");
}

function runImporter(paths, out) {
  return spawnSync(
    process.execPath,
    [importer, ...paths, "--out", out, "--verify"],
    { encoding: "utf8", windowsHide: true },
  );
}

test("profile.md without id or name uses its parent agent directory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iqra-customagents-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent-without-id");
  const source = join(agentDir, "profile.md");
  const out = join(root, "out");
  await mkdir(agentDir, { recursive: true });
  await writeFile(source, profile(), "utf8");

  const result = runImporter([source], out);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(await readdir(out), ["agent-without-id.md"]);
  assert.match(
    await readFile(join(out, "agent-without-id.md"), "utf8"),
    /^---\nname: agent-without-id\n/,
  );
  assert.match(result.stdout, /VERIFY : OK  name="agent-without-id"/);
});

test("duplicate normalized ids abort before writing any definitions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iqra-customagents-collision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first", "profile.md");
  const second = join(root, "second", "profile.md");
  const out = join(root, "out");
  await mkdir(join(root, "first"), { recursive: true });
  await mkdir(join(root, "second"), { recursive: true });
  await writeFile(first, profile({ id: "same-agent" }), "utf8");
  await writeFile(second, profile({ id: "same_agent" }), "utf8");

  const result = runImporter([first, second], out);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Duplicate normalized agent id\(s\); nothing was written/);
  assert.match(result.stderr, /same-agent:/);
  assert.equal(existsSync(out), false, "collision must abort before mkdir/writeFile");
});
