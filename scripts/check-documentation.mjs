#!/usr/bin/env node
/**
 * Run the pinned documentation checker and reject unresolved observations.
 * CI must supply DOCS_BASE_REF from the event's trusted base revision.
 * Local reviewers may supply --base-ref REV for the same baseline comparison.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--base-ref" || !args[1])) {
    throw new Error("Usage: node scripts/check-documentation.mjs [--base-ref REV]");
  }
  const base = args[1] ?? process.env.DOCS_BASE_REF;
  const ci = process.env.CI === "true" || process.env.CI === "1";
  if (ci && !base) throw new Error("CI requires DOCS_BASE_REF from the workflow event");
  if (base) {
    const resolved = spawnSync("git", ["rev-parse", "--verify", base + "^{commit}"], {
      cwd: root, encoding: "utf8", windowsHide: true,
    });
    if (resolved.status !== 0) throw new Error("Documentation base commit is unavailable: " + base);
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(root, ".agents/docs/tools/install.json"), "utf8"));
  for (const name of [".agents/docs/tools/docctl.mjs", ".agents/docs/tools/THIRD-PARTY-NOTICES"]) {
    const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex");
    if (actual !== receipt.files?.[name]) throw new Error("Pinned documentation tool changed without updating its receipt: " + name);
  }
  const command = [path.join(root, ".agents/docs/tools/docctl.mjs"), "check", root, "--json"];
  if (base) command.push("--base-ref", base);
  const result = spawnSync(process.execPath, command, {
    cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status === null) throw new Error(result.error?.message ?? result.stderr);
  const report = JSON.parse(result.stdout);
  const unresolved = report.unknown?.length ?? 0;
  const code = result.status || (unresolved ? 1 : 0);
  if (code) console.error(JSON.stringify(report, null, 2));
  else console.log("Documentation audit passed: " + report.files + " pages, no new findings or unresolved observations.");
  process.exitCode = code;
} catch (error) {
  console.error("Documentation gate could not run: " + error.message);
  process.exitCode = 2;
}
