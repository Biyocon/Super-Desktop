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

function runImporter(paths, out, extraArgs = []) {
  const outArgs = out ? ["--out", out] : [];
  return spawnSync(
    process.execPath,
    [importer, ...paths, ...outArgs, "--verify", ...extraArgs],
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
  const generated = await readFile(join(out, "agent-without-id.md"), "utf8");
  assert.match(generated, /^---\nname: agent-without-id\n/);
  assert.match(generated, /^tools: \[Read, Glob, Grep\]$/m);
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

test("default output is the inactive CustomAgents library", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iqra-customagents-default-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "library-agent");
  const source = join(agentDir, "profile.md");
  await mkdir(agentDir, { recursive: true });
  await writeFile(source, profile(), "utf8");

  const result = runImporter([source], null, ["--dry-run"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\.agents[\\/]subagent-library[\\/]customagents/);
  assert.match(result.stdout, /status : dry-run/);
});

test("identical library definitions are idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iqra-customagents-unchanged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "same-agent");
  const source = join(agentDir, "profile.md");
  const out = join(root, "out");
  await mkdir(agentDir, { recursive: true });
  await writeFile(source, profile(), "utf8");

  const first = runImporter([source], out);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const before = await readFile(join(out, "same-agent.md"), "utf8");
  const second = runImporter([source], out);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.match(second.stdout, /status : unchanged/);
  assert.match(second.stdout, /0 new, 1 unchanged/);
  assert.equal(await readFile(join(out, "same-agent.md"), "utf8"), before);
});

test("a non-identical target aborts the batch without clobbering or partial writes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iqra-customagents-no-clobber-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const firstDir = join(root, "same-agent");
  const secondDir = join(root, "new-agent");
  const first = join(firstDir, "profile.md");
  const second = join(secondDir, "profile.md");
  const out = join(root, "out");
  await mkdir(firstDir, { recursive: true });
  await mkdir(secondDir, { recursive: true });
  await mkdir(out, { recursive: true });
  await writeFile(first, profile(), "utf8");
  await writeFile(second, profile(), "utf8");
  await writeFile(join(out, "same-agent.md"), "existing custom content\n", "utf8");

  const result = runImporter([first, second], out);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Existing non-identical library definition\(s\)/);
  assert.equal(
    await readFile(join(out, "same-agent.md"), "utf8"),
    "existing custom content\n",
  );
  assert.equal(existsSync(join(out, "new-agent.md")), false);
});

test("definitions beyond the host 32 KiB limit are rejected before writing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "iqra-customagents-size-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "large-agent");
  const source = join(agentDir, "profile.md");
  const out = join(root, "out");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    source,
    profile().replace("You are the Test specialist.", "x".repeat(33 * 1024)),
    "utf8",
  );

  const result = runImporter([source], out);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /maximum is 32768/);
  assert.equal(existsSync(out), false);
});
