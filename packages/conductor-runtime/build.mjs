import { createHash } from "node:crypto";
import { readFileSync, readdirSync, copyFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const vendor = resolve(root, "vendor");
const manifest = JSON.parse(readFileSync(resolve(vendor, "manifest.json"), "utf8"));
if (manifest.revision !== "879ab27bdd22203675d6f0cc678652779fc089cd" || manifest.packageVersion !== "0.1.0-rc.7" || manifest.license !== "MIT") throw new Error("CONDUCTOR_SOURCE_INCOMPATIBLE");
const actual = readdirSync(vendor, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => resolve(entry.parentPath, entry.name));
const expected = new Set([resolve(vendor, "manifest.json")]);
for (const item of manifest.files) {
  if (!/^(LICENSE|conductor\/[a-z-]+\.ts|guards\/(capability|path-policy)\.ts)$/.test(item.path)) throw new Error("CONDUCTOR_SOURCE_PATH_INVALID");
  const path = resolve(vendor, item.path);
  if (expected.has(path)) throw new Error("CONDUCTOR_SOURCE_DUPLICATE");
  expected.add(path);
  const bytes = readFileSync(path);
  if (bytes.length !== item.bytes || createHash("sha256").update(bytes).digest("hex") !== item.sha256) throw new Error(`CONDUCTOR_SOURCE_DRIFT: ${item.path}`);
}
if (actual.length !== expected.size || actual.some(path => !expected.has(path))) throw new Error("CONDUCTOR_SOURCE_UNEXPECTED_FILE");
await build({
  entryPoints: [resolve(root, "src/engine.mjs")], outfile: resolve(root, "dist/engine.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", legalComments: "inline",
  alias: { "@deepseek-ai/dsh-conductor": resolve(vendor, "conductor/index.ts") },
});
await build({
  entryPoints: [resolve(root, "src/index.mjs")], outfile: resolve(root, "dist/adapter.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", legalComments: "inline",
  plugins: [{ name: "shared-authoritative-engine", setup(builder) {
    builder.onResolve({ filter: /^\.\.\/dist\/engine\.mjs$/ }, () => ({ path: "./engine.mjs", external: true }));
  } }],
});
copyFileSync(resolve(vendor, "LICENSE"), resolve(root, "dist/HARNESS-LICENSE"));
const zodLicense = resolve(dirname(createRequire(import.meta.url).resolve("zod/package.json")), "LICENSE");
copyFileSync(zodLicense, resolve(root, "dist/ZOD-LICENSE"));
const { declarationArtifacts } = await import("./build-types.mjs");
const artifacts = Object.fromEntries(["engine.mjs", "adapter.mjs", "HARNESS-LICENSE", "ZOD-LICENSE", ...declarationArtifacts].map(name => [name,
  createHash("sha256").update(readFileSync(resolve(root, "dist", name))).digest("hex")]));
writeFileSync(resolve(root, "dist/provenance.json"), JSON.stringify({ ...manifest, artifacts }, null, 2) + "\n");
console.log(`CONDUCTOR_BUILD_PASS: ${manifest.files.length} pinned source files; shared engine and adapter; MIT notices retained`);
