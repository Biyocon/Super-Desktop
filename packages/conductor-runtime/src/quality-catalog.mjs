import { createHash } from "node:crypto";
import { z } from "zod";

const text = z.string().min(1).max(8192).refine(value => !value.includes("\0"));
const definition = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  argv: z.array(text).min(1).max(64),
  requiredGates: z.array(z.enum(["D", "E"])).min(1).max(2),
  timeoutMs: z.number().int().min(100).max(300000),
  outputLimitBytes: z.number().int().min(256).max(1048576),
}).strict();

export const sha256 = value => createHash("sha256").update(value).digest("hex");

/** Only host-owned definitions enter here, never repository scripts or model proposals. */
export function createQualityCatalog(input) {
  const definitions = z.array(definition).max(32).parse(input);
  const entries = new Map();
  for (const item of definitions) {
    if (entries.has(item.id) || new Set(item.requiredGates).size !== item.requiredGates.length) throw new Error("CONDUCTOR_CATALOG_DUPLICATE");
    // Fixed field order and gate order make the complete definition hash reproducible.
    const normalized = { id: item.id, image: item.image, argv: [...item.argv], requiredGates: [...item.requiredGates].sort(),
      timeoutMs: item.timeoutMs, outputLimitBytes: item.outputLimitBytes };
    entries.set(item.id, { ...normalized, definitionHash: sha256(JSON.stringify(normalized)) });
  }
  const binding = item => ({ id: item.id, definitionHash: item.definitionHash, requiredGates: [...item.requiredGates] });
  return Object.freeze({
    bindings() { return [...entries.values()].map(binding); },
    resolve(ids) {
      if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) throw new Error("CONDUCTOR_CATALOG_SELECTION_INVALID");
      return ids.map(id => {
        const item = entries.get(id);
        if (!item) throw new Error("CONDUCTOR_COMMAND_UNKNOWN");
        return binding(item);
      });
    },
    command(requested, gate) {
      const item = entries.get(requested?.id);
      if (!item || requested.definitionHash !== item.definitionHash
        || JSON.stringify(requested.requiredGates) !== JSON.stringify(item.requiredGates)
        || !item.requiredGates.includes(gate)) throw new Error("CONDUCTOR_COMMAND_BINDING_INVALID");
      return structuredClone(item);
    },
  });
}
