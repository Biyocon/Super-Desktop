import ts from "typescript";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";

const root = dirname(fileURLToPath(import.meta.url));
const program = ts.createProgram([resolve(root, "types/consumer.mts")], {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true, noEmit: true, skipLibCheck: false, types: ["node"],
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: path => path, getCurrentDirectory: () => root, getNewLine: () => "\n",
  }));
  process.exitCode = 1;
} else {
  for (const entry of readdirSync(resolve(root, "dist/types"), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
    const source = ts.createSourceFile(entry.name, readFileSync(resolve(entry.parentPath, entry.name), "utf8"), ts.ScriptTarget.Latest, true);
    const check = node => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) throw new Error(`CONDUCTOR_PUBLIC_TYPE_ANY: ${entry.name}`);
      ts.forEachChild(node, check);
    };
    check(source);
  }
  console.log("CONDUCTOR_TYPES_PASS: strict generated declarations and negative consumer contracts; no public any");
}
