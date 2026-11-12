import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Maintenance-only import. Runtime and ordinary builds never read a developer checkout.
const revision = "879ab27bdd22203675d6f0cc678652779fc089cd";
const source = process.argv[2];
if (!source || process.argv.length !== 3) throw new Error("Usage: node scripts/vendor-harness-conductor.mjs <read-only-source-checkout>");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(root, "packages/conductor-runtime/vendor");
if (existsSync(destination)) throw new Error("Vendor destination already exists; review an explicit replacement separately");
const git = (args) => execFileSync("git", ["-C", resolve(source), ...args], { maxBuffer: 8 * 1024 * 1024 });
if (git(["rev-parse", "HEAD"]).toString().trim() !== revision) throw new Error("Harness revision mismatch");
if (git(["status", "--porcelain", "--untracked-files=no"]).length) throw new Error("Harness tracked sources are dirty");
const core = "packages/conductor/conductor/src/";
const selected = git(["ls-tree", "-r", "--name-only", revision, "--", core]).toString().trim().split("\n").filter(Boolean);
selected.push("LICENSE", "packages/conductor/tool-conductor/src/capability.ts", "packages/conductor/tool-conductor/src/path-policy.ts");
const manifest = { revision, license: "MIT", packageVersion: "0.1.0-rc.7", files: [] };
for (const path of selected.sort()) {
  if (!/^(LICENSE|packages\/conductor\/(conductor\/src\/[a-z-]+\.ts|tool-conductor\/src\/(capability|path-policy)\.ts))$/.test(path)) throw new Error(`Unexpected source path: ${path}`);
  const bytes = git(["show", `${revision}:${path}`]);
  const relative = path === "LICENSE" ? path : path.startsWith(core) ? `conductor/${path.slice(core.length)}` : `guards/${path.split("/").at(-1)}`;
  const target = resolve(destination, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: "wx" });
  manifest.files.push({ source: path, path: relative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
writeFileSync(resolve(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
console.log(`Imported ${manifest.files.length} unchanged tracked Harness files at ${revision}; MIT notice retained.`);
