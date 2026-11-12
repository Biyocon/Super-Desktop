import { Type } from "@earendil-works/pi-ai";

const path = (description: string) => Type.Optional(Type.String({ description }));
const alias = (canonical: string) => path(`Alias for \`${canonical}\`.`);

/** Shared host wire schemas. Permission and path policy remain in host-core. */
export function fileToolParameters(): Record<string, Parameters<typeof Type.Object>[0]> {
  return {
    Read: {
      path: path("Existing regular file only, never a directory; workspace-relative or explicitly approved."),
      file_path: alias("path"),
      offset: Type.Optional(Type.Number({ minimum: 0, description: "0-based line offset; defaults to 0." })),
      limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum lines to return; defaults to 2000." })),
    },
    Glob: {
      pattern: path("Glob pattern, for example **/*.ts."), query: alias("pattern"),
      path: path("Directory to search; defaults to the workspace root and accepts an absolute scratch path."),
      limit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum entries; defaults to 100." })),
    },
    Grep: {
      pattern: path("Rust-compatible regex matched per line."), query: alias("pattern"),
      path: path("File or directory to search; defaults to the workspace root and accepts an absolute scratch path."),
      include: path("Glob filter, for example **/*.{ts,tsx}."),
      outputMode: Type.Optional(Type.Union([Type.Literal("content"), Type.Literal("filesWithMatches"), Type.Literal("count")])),
      headLimit: Type.Optional(Type.Number({ minimum: 1, description: "Maximum matches or files; defaults to 200." })),
      caseInsensitive: Type.Optional(Type.Boolean()),
    },
    Write: { path: path("File to write; workspace-relative."), file_path: alias("path"), content: Type.String() },
    Edit: {
      path: path("File to edit; workspace-relative."), file_path: alias("path"),
      tag: Type.String({ description: "4 uppercase hex from the latest Read, Grep, Write, or Edit for this path." }),
      ops: Type.String({ description: "One or more operation headers with + body rows, newline separated. A PUT with body rows must end its header with `:` (for example, `PUT 48.=48:`); `PUT 48.=48` followed by + rows is invalid. A colonless PUT is only for a register paste such as `PUT <1 @name`." }),
    },
  };
}
