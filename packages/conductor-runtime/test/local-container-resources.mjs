// Explicit OS-boundary harness for low-level sandbox tests, not production or
// persistence acceptance. Product runs use Rust-owned resource creation only.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { seccompPolicy } from "../src/container-policy.mjs";

export function localContainerResources(docker, scratchRoot, workspace, catalog) {
  const host = process.platform === "win32" ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock";
  const env = Object.fromEntries(["SystemRoot", "WINDIR"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  return {
    async create(request, probeArgv) {
      const temporary = await mkdtemp(join(scratchRoot, "quality-os-fixture-"));
      await chmod(temporary, 0o755);
      const policy = JSON.stringify(seccompPolicy);
      await writeFile(join(temporary, "seccomp.json"), policy, { flag: "wx" });
      const command = catalog.command(request.binding, request.gate);
      const argv = probeArgv ?? command.argv, resourceId = randomUUID(), containerName = `super-conductor-${resourceId}`;
      const result = spawnSync(docker, ["--config", temporary, "--host", host, "create", "--pull", "never", "--name", containerName,
        "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--security-opt", `seccomp=${join(temporary, "seccomp.json")}`,
        "--pids-limit", "64", "--memory", "256m", "--cpus", "1", "--user", "65534:65534", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777",
        "--mount", `type=bind,src=${probeArgv ? temporary : workspace},dst=/workspace,readonly`, "--workdir", "/workspace", "--entrypoint", argv[0], command.image, ...argv.slice(1)],
        { env, shell: false, windowsHide: true, encoding: "utf8", timeout: 15000, maxBuffer: 8192 });
      if (result.status !== 0) {
        await rm(temporary, { recursive: true, force: true });
        throw new Error(`OS fixture container create failed: ${result.stderr}`);
      }
      return { resourceId, containerName, temporary, policySha256: createHash("sha256").update(policy).digest("hex") };
    },
    async release(resource) {
      const result = spawnSync(docker, ["--config", resource.temporary, "--host", host, "rm", "--force", resource.containerName],
        { env, shell: false, windowsHide: true, encoding: "utf8", timeout: 10000, maxBuffer: 8192 });
      assert.ok(result.status === 0 || result.stderr.includes(`No such container: ${resource.containerName}`), result.stderr);
      await rm(resource.temporary, { recursive: true, force: true });
    },
  };
}
