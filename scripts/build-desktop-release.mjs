import { spawn } from "node:child_process";
import process from "node:process";

const forwardedArgs = process.argv.slice(2);
const packOnly = forwardedArgs[0] === "pack";
if (packOnly) forwardedArgs.shift();

const hostTarget =
  process.platform === "win32"
    ? "win"
    : process.platform === "darwin"
      ? "mac"
      : "linux";
const requestedTarget = ["linux", "mac", "win"].includes(forwardedArgs[0])
  ? forwardedArgs.shift()
  : undefined;
const target = requestedTarget ?? hostTarget;

if (!["linux", "mac", "win"].includes(target)) {
  throw new Error(`Unsupported desktop release target: ${target}`);
}

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runBuilder(args) {
  return new Promise((resolve, reject) => {
    const configuration = target === "win" ? ["--config", "electron-builder.windows.cjs"] : [];
    const child = spawn(pnpmCommand, ["exec", "electron-builder", ...configuration, ...args], {
      // Windows exposes pnpm as a .cmd shim. Launch it through the shell so
      // Node can start the shim consistently on the hosted Windows runner.
      shell: process.platform === "win32",
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `electron-builder ${target} target failed with ${
            code === null ? `signal ${signal ?? "unknown"}` : `exit code ${code}`
          }`,
        ),
      );
    });
  });
}

if (packOnly) {
  await runBuilder([`--${target}`, "--dir", "--publish", "never", ...forwardedArgs]);
} else if (target === "win") {
  await runBuilder([
    "--win",
    "nsis",
    "--publish",
    "never",
    ...forwardedArgs,
    "-c.extraMetadata.piDistribution=installed",
  ]);
  await runBuilder([
    "--win",
    "zip",
    "--publish",
    "never",
    ...forwardedArgs,
    "-c.extraMetadata.piDistribution=zip",
  ]);
  await runBuilder([
    "--win",
    "portable",
    "--publish",
    "never",
    ...forwardedArgs,
    "-c.extraMetadata.piDistribution=portable",
  ]);
} else {
  await runBuilder([
    `--${target}`,
    "--publish",
    "never",
    ...forwardedArgs,
  ]);
}
