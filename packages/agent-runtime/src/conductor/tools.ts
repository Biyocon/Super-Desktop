import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ProviderDispatch } from "@pi-desktop/conductor-runtime/adapter";
import { fileToolParameters } from "../file-tool-parameters.js";

const names: Readonly<Record<string, string>> = { read: "Read", grep: "Grep", glob: "Glob", write: "Write", edit: "Edit" };
const descriptions: Readonly<Record<string, string>> = {
  read: "Read a regular text file. Returns line numbers and a whole-file Edit tag. Use offset/limit for bounded windows.",
  glob: "List workspace files by pattern. Paths must stay in the selected repository.",
  grep: "Search file contents with a Rust regex. Use a bounded headLimit and scoped path.",
  write: "Create or overwrite an authorized workspace file only. No external actions or scope expansion.",
  edit: "Edit an authorized file using its current 4-hex tag and line operations: PUT N.=M:, PUT <N:, PUT >N:, PUT >$:, CUT N.=M, or REM. Content rows start with +. Rename/MV is not supported.",
};

export function conductorHostToolName(name: string): string {
  const hostName = names[name];
  if (!hostName) throw new Error("CONDUCTOR_TOOL_DENIED");
  return hostName;
}

/** One effective path is used by both the Harness guard and the Rust executor. */
export function conductorToolArguments(name: string, raw: unknown): Record<string, unknown> {
  conductorHostToolName(name);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("CONDUCTOR_TOOL_ARGUMENTS_INVALID");
  const args = { ...raw } as Record<string, unknown>;
  const path = args.path ?? args.file_path ?? (name === "glob" || name === "grep" ? "." : undefined);
  if (typeof path !== "string" || !path.trim() || (args.path !== undefined && args.file_path !== undefined && args.path !== args.file_path)) {
    throw new Error("CONDUCTOR_TOOL_PATH_AMBIGUOUS");
  }
  // Reject undeclared aliases, including old Edit mutations, rather than let a
  // downstream normalizer select a different target than the guard assessed.
  const permitted = new Set(Object.keys(fileToolParameters()[conductorHostToolName(name)] ?? {}));
  if (Object.keys(args).some(key => !permitted.has(key))) throw new Error("CONDUCTOR_TOOL_ARGUMENTS_INVALID");
  if (name === "edit" && (typeof args.ops !== "string" || args.ops.split(/\r\n|\n|\r/).some(line => /^\s*MV(?:\s|$)/i.test(line)) || /(^|\r?\n)PUT[^\n]*@/.test(args.ops))) {
    throw new Error("CONDUCTOR_EDIT_RENAME_DENIED");
  }
  delete args.file_path;
  if (args.query !== undefined) {
    if (args.pattern !== undefined && args.pattern !== args.query) throw new Error("CONDUCTOR_TOOL_PATTERN_AMBIGUOUS");
    args.pattern = args.query;
    delete args.query;
  }
  return { ...args, path, file_path: path };
}

function toolResult(value: unknown) {
  const result = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const content = result && "content" in result ? result.content : value;
  return {
    content: [{ type: "text" as const, text: typeof content === "string" ? content : JSON.stringify(content) ?? "null" }],
    details: value,
    isError: result?.ok === false || result?.isError === true || result?.denied === true,
  };
}

/** No generic Task, shell, plugin, MCP, image or owner-interaction capability. */
export function conductorTools(request: ProviderDispatch): AgentTool[] {
  // An independent critic receives exactly the reserved prompt, no extra tool
  // definitions/history. Its cited materials were already selected by Harness.
  if (request.mode === "critic") return [];
  const schemas = fileToolParameters();
  const tools: AgentTool[] = request.tools.filter(name => names[name]).map(name => ({
    name, label: name, description: descriptions[name] ?? name,
    parameters: Type.Object(schemas[conductorHostToolName(name)] ?? {}, { additionalProperties: false }),
    execute: async (_id, raw, signal) => {
      signal?.throwIfAborted();
      request.signal.throwIfAborted();
      return toolResult(await request.executeTool(name, conductorToolArguments(name, raw)));
    },
  }));
  if (request.requiredQualityCommands.length) tools.push({
    name: "quality", label: "quality",
    description: "Run a host-fixed, confined quality command. Only listed catalog ids are accepted. Cite the returned evidenceId; never invent command evidence.",
    parameters: Type.Object({ commandId: Type.String({ enum: request.requiredQualityCommands.map(binding => binding.id) }) }, { additionalProperties: false }),
    execute: async (_id, args, signal) => {
      signal?.throwIfAborted();
      request.signal.throwIfAborted();
      if (!args || typeof args !== "object" || !("commandId" in args) || typeof args.commandId !== "string") throw new Error("CONDUCTOR_QUALITY_ARGUMENTS_INVALID");
      return toolResult(await request.quality(args.commandId));
    },
  });
  return tools;
}
