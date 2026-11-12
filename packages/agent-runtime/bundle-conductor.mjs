import { build } from "esbuild";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = new URL("./", import.meta.url);
const source = new URL("../conductor-runtime/dist/", here);
const output = new URL("dist-bundle/", here);
const names = ["engine.mjs", "adapter.mjs", "HARNESS-LICENSE", "ZOD-LICENSE"];
const provenanceBytes = await readFile(new URL("provenance.json", source));
const provenance = JSON.parse(provenanceBytes);
if (provenance.revision !== "879ab27bdd22203675d6f0cc678652779fc089cd" || provenance.packageVersion !== "0.1.0-rc.7" || provenance.license !== "MIT") throw new Error("CONDUCTOR_ENGINE_INCOMPATIBLE");
const artifacts = new Map();
for (const name of names) {
  const bytes = await readFile(new URL(name, source));
  if (createHash("sha256").update(bytes).digest("hex") !== provenance.artifacts[name]) throw new Error("CONDUCTOR_ENGINE_INCOMPATIBLE");
  artifacts.set(name, bytes);
}
// Never traverse a mutable build-output junction belonging to another tree.
for (const path of ["dist-bundle/", "dist-bundle/node_modules/", "dist-bundle/node_modules/@pi-desktop/", "dist-bundle/node_modules/@pi-desktop/conductor-runtime/", "dist-bundle/node_modules/@pi-desktop/conductor-runtime/dist/"]) {
  const url = new URL(path, here);
  const stat = await lstat(url).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("CONDUCTOR_BUNDLE_PATH_INVALID");
  await mkdir(url, { recursive: true });
}
// Refuse individual links too, before esbuild or any copy can overwrite them.
for (const path of ["service.js", "node_modules/@pi-desktop/conductor-runtime/package.json",
  ...[...names, "provenance.json"].map(name => `node_modules/@pi-desktop/conductor-runtime/dist/${name}`)]) {
  const stat = await lstat(new URL(path, output)).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error("CONDUCTOR_BUNDLE_PATH_INVALID");
}
await build({
  absWorkingDir: fileURLToPath(here), entryPoints: ["src/conductor/service.ts"],
  bundle: true, platform: "node", format: "esm", minify: true,
  define: { PI_BUNDLED_NODE: "true" }, outfile: fileURLToPath(new URL("service.js", output)),
  external: ["@pi-desktop/conductor-runtime/*"],
  banner: { js: "import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);" },
});
const destination = new URL("node_modules/@pi-desktop/conductor-runtime/", output);
for (const [name, bytes] of artifacts) await writeFile(new URL(`dist/${name}`, destination), bytes, { flag: "w" });
await writeFile(new URL("dist/provenance.json", destination), provenanceBytes);
await writeFile(new URL("package.json", destination), JSON.stringify({ name: "@pi-desktop/conductor-runtime", private: true, type: "module",
  exports: { "./engine": "./dist/engine.mjs", "./adapter": "./dist/adapter.mjs" } }, null, 2) + "\n");
console.log("Conductor service bundled with one verified external Harness engine and licenses.");
