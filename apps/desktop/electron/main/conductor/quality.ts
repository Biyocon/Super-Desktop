import { execFile } from "node:child_process";
import { lstat, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ConductorQualityCommand } from "@pi-desktop/shared";
import { invalid } from "./input";

// Optional local prerequisite only. Never pull an image or execute repository shell scripts.
const commands: ConductorQualityCommand[] = [{
  id: "node-tests",
  image: "sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0",
  argv: ["/usr/local/bin/node", "--test", "--test-isolation=none"], requiredGates: ["D", "E"], timeoutMs: 120000, outputLimitBytes: 65536,
}];
export function conductorQualityCatalog(): ConductorQualityCommand[] { return structuredClone(commands); }
export function selectQualityCommands(ids: string[]): ConductorQualityCommand[] {
  return ids.map(id => {
    const command = commands.find(item => item.id === id);
    if (!command) invalid("CONDUCTOR_COMMAND_UNKNOWN");
    return structuredClone(command);
  });
}
function inspect(executable: string, config: string, image: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, ["--config", config, "--host", process.platform === "win32" ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock",
      "image", "inspect", image, "--format", "{{.Id}} {{.Os}}/{{.Architecture}}"],
    { timeout: 15000, maxBuffer: 4096, windowsHide: true, env: {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    } }, (error, stdout) => error ? reject(Object.assign(new Error("CONDUCTOR_CONTAINER_UNAVAILABLE"), { errorCode: "CONDUCTOR_CONTAINER_UNAVAILABLE" })) : resolve(stdout.trim()));
  });
}
/** Fixed installation locations and digest inspection; no PATH, Docker contexts or user config. */
export async function resolveConductorDocker(selected: ConductorQualityCommand[]): Promise<string> {
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"]
    : process.platform === "darwin" ? ["/Applications/Docker.app/Contents/Resources/bin/docker"] : ["/usr/bin/docker", "/usr/local/bin/docker"];
  let executable: string | undefined;
  for (const path of candidates) {
    try { const stat = await lstat(path); if (isAbsolute(path) && stat.isFile() && !stat.isSymbolicLink()) { executable = path; break; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!executable) invalid("CONDUCTOR_CONTAINER_UNAVAILABLE");
  const config = await mkdtemp(join(tmpdir(), "super-conductor-inspect-"));
  try {
    await writeFile(join(config, "config.json"), "{}", { flag: "wx", mode: 0o600 });
    for (const image of new Set(selected.map(item => item.image))) {
      if (await inspect(executable, config, image) !== `${image} linux/amd64`) invalid("CONDUCTOR_CONTAINER_IMAGE_UNAVAILABLE");
    }
    return executable;
  } finally {
    // Only this unpredictable directory and the one file created above are ours.
    await rm(join(config, "config.json"));
    await rmdir(config);
  }
}
