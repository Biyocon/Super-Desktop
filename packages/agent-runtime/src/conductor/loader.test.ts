import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectEngine } from "./loader.js";

function fixture(check: (root: string, resolve: () => string) => void) {
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "conductor-loader-"));
  try {
    const artifacts: Record<string, string> = {};
    for (const name of ["engine.mjs", "adapter.mjs", "HARNESS-LICENSE", "ZOD-LICENSE"]) {
      const content = `owned fixture ${name}`;
      writeFileSync(join(root, name), content);
      artifacts[name] = createHash("sha256").update(content).digest("hex");
    }
    writeFileSync(join(root, "provenance.json"), JSON.stringify({ revision: "879ab27bdd22203675d6f0cc678652779fc089cd", packageVersion: "0.1.0-rc.7", license: "MIT", artifacts }));
    check(root, () => pathToFileURL(join(root, "engine.mjs")).href);
  } finally { rmSync(root, { force: true, recursive: true }); }
}

describe("Conductor optional engine loader", () => {
  it("verifies the actual pinned shared artifacts and licenses", () => {
    expect(inspectEngine()).toMatchObject({ revision: "879ab27bdd22203675d6f0cc678652779fc089cd", version: "0.1.0-rc.7", license: "MIT", recordFormat: 5 });
  });
  it("reports an unavailable engine without trying a normal chat fallback", () => {
    expect(() => inspectEngine(() => { throw new Error("Owned missing module"); })).toThrow("ENGINE_UNAVAILABLE");
  });
  it("rejects changed engine/adapter bytes before module execution", () => fixture((root, resolve) => {
    expect(inspectEngine(resolve).recordFormat).toBe(5);
    writeFileSync(join(root, "adapter.mjs"), "throw new Error('must never execute fixture');");
    expect(() => inspectEngine(resolve)).toThrow("ENGINE_INCOMPATIBLE");
  }));
  it("rejects an incompatible source/runtime version", () => fixture((root, resolve) => {
    const provenance = JSON.parse(readFileSync(join(root, "provenance.json"), "utf8"));
    provenance.packageVersion = "unapproved-fixture-version";
    writeFileSync(join(root, "provenance.json"), JSON.stringify(provenance));
    expect(() => inspectEngine(resolve)).toThrow("ENGINE_INCOMPATIBLE");
  }));
});
