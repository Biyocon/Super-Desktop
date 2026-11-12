import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { z } from "zod";
import { canonicalAbsolute, containsPath } from "../dist/engine.mjs";

const text = z.string().trim().min(1).max(8192);
const schema = z.object({
  owner: text, objective: text, purpose: z.enum(["analysis", "implementation"]),
  scope: z.array(text).min(1).max(64),
  allowedPaths: z.array(text).max(128), excludedPaths: z.array(text).max(128),
  qualityCommandIds: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(32),
  sourceBaseline: text,
}).strict();
const proposalSchema = z.object({ scopeVersion: text, planVersion: text, acceptanceVersion: text,
  rollbackReference: text, qualityCommandIds: z.array(text).min(1).max(32) }).strict();
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Host-created authority snapshot. It cannot approve tools or make gate decisions. */
export function captureMandate(workspace, input, catalog) {
  const mandate = schema.parse(input);
  const root = realpathSync.native(workspace);
  if (!statSync(root).isDirectory()) throw new Error("CONDUCTOR_WORKSPACE_INVALID");
  const path = value => {
    if (isAbsolute(value) || /[\0\r\n*?\[\]:]/.test(value) || value.split(/[\\/]/).some(part => part === ".." || part.toLowerCase() === ".git")) throw new Error("CONDUCTOR_SCOPE_PATH_INVALID");
    const canonical = canonicalAbsolute(root, value);
    if (!containsPath(root, canonical) || relative(root, canonical) === "") throw new Error("CONDUCTOR_SCOPE_ESCAPE");
    return { declared: value, canonical };
  };
  if (mandate.purpose === "analysis" && (mandate.allowedPaths.length || mandate.qualityCommandIds.length)) throw new Error("CONDUCTOR_ANALYSIS_MUTATION_DENIED");
  if (mandate.purpose === "implementation" && !mandate.allowedPaths.length) throw new Error("CONDUCTOR_SCOPE_EMPTY");
  const allowed = mandate.allowedPaths.map(path), excluded = mandate.excludedPaths.map(path);
  const bindings = mandate.purpose === "implementation" ? catalog.resolve(mandate.qualityCommandIds) : [];
  if (mandate.purpose === "implementation" && ["D", "E"].some(gate => !bindings.some(item => item.requiredGates.includes(gate)))) throw new Error("CONDUCTOR_QUALITY_GATES_MISSING");
  if (new Set(allowed.map(item => item.canonical)).size !== allowed.length || new Set(excluded.map(item => item.canonical)).size !== excluded.length) throw new Error("CONDUCTOR_SCOPE_DUPLICATE");
  const frozen = { ...mandate, workspace: root, allowedPaths: allowed.map(item => item.canonical), excludedPaths: excluded.map(item => item.canonical), qualityCommands: bindings };
  function validate(run) {
    if (realpathSync.native(workspace) !== root || realpathSync.native(root) !== root) throw new Error("CONDUCTOR_WORKSPACE_CHANGED");
    for (const item of [...allowed, ...excluded]) {
      if (canonicalAbsolute(root, item.declared) !== item.canonical) throw new Error("CONDUCTOR_SCOPE_CHANGED");
    }
    if (run.authority.owner !== frozen.owner || run.objective !== frozen.objective || run.admission.purpose !== frozen.purpose
      || !same(run.scope, frozen.scope) || !same(run.allowedPaths, frozen.allowedPaths) || !same(run.excludedPaths, frozen.excludedPaths)
      || run.sourceBaseline !== frozen.sourceBaseline) throw new Error("CONDUCTOR_MANDATE_CHANGED");
    if (run.baseline && !same(run.baseline.qualityCommands, bindings)) throw new Error("CONDUCTOR_CATALOG_CHANGED");
  }
  return Object.freeze({
    snapshot() { return structuredClone(frozen); },
    validate,
    resolveBaseline(run, input) {
      validate(run);
      const proposal = proposalSchema.parse(input);
      if (proposal.rollbackReference !== frozen.sourceBaseline || !same(proposal.qualityCommandIds, frozen.qualityCommandIds)) throw new Error("CONDUCTOR_BASELINE_SCOPE_CHANGED");
      const { qualityCommandIds: _ids, ...versions } = proposal;
      return { ...versions, allowedPaths: [...frozen.allowedPaths], excludedPaths: [...frozen.excludedPaths], qualityCommands: structuredClone(bindings) };
    },
  });
}
