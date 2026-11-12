import ts from "typescript";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const destination = resolve(root, "dist/types");
const options = {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  declaration: true, emitDeclarationOnly: true, allowImportingTsExtensions: true,
  rootDir: root, declarationDir: destination,
  // Compile unchanged engine contracts against erased structural service types.
  strict: true, skipLibCheck: false, types: ["node"], baseUrl: root,
  paths: {
    "@deepseek-ai/dsh-conductor": ["vendor/conductor/index.ts"],
    "@deepseek-ai/dsh-*": ["types/compat.d.ts"],
    "@deepseek-ai/cordis": ["types/compat.d.ts"],
  },
};
const program = ts.createProgram([resolve(root, "types/engine.ts")], options);
const external = new Set([
  "@deepseek-ai/dsh-brand", "@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session/types",
  "@deepseek-ai/dsh-tools", "@deepseek-ai/cordis", "@deepseek-ai/dsh-session-projection",
  "@deepseek-ai/dsh-session-projection/types",
]);
const outputs = [];
const result = program.emit(undefined, (path, text) => {
  const target = resolve(path);
  if (!target.startsWith(destination + "/") && !target.startsWith(destination + "\\")) throw new Error("CONDUCTOR_TYPES_OUTPUT_ESCAPE");
  let compat = relative(dirname(target), resolve(destination, "compat.js")).replaceAll("\\", "/");
  if (!compat.startsWith(".")) compat = "./" + compat;
  // Operate only on literal module specifiers, not signatures, docs or source.
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const edits = [];
  const visit = node => {
    if (ts.isStringLiteral(node) && (
      (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) && node.parent.moduleSpecifier === node
      || ts.isModuleDeclaration(node.parent) && node.parent.name === node
      || ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent)
    )) {
      let name = node.text;
      if (external.has(name)) name = compat;
      else if (name === "@deepseek-ai/dsh-conductor") name = "../conductor/index.js";
      else if (name.startsWith("@deepseek-ai/")) throw new Error(`CONDUCTOR_TYPES_UNKNOWN_SERVICE: ${name}`);
      else if (name.startsWith(".") && name.endsWith(".ts")) name = name.slice(0, -3) + ".js";
      if (name !== node.text) edits.push([node.getStart(source), node.end, JSON.stringify(name)]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const [start, end, replacement] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + replacement + text.slice(end);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  outputs.push(relative(resolve(root, "dist"), target).replaceAll("\\", "/"));
});
const diagnostics = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics];
if (result.emitSkipped || diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: path => path, getCurrentDirectory: () => root, getNewLine: () => "\n" }));
  throw new Error("CONDUCTOR_TYPES_EMIT_FAILED");
}
mkdirSync(destination, { recursive: true });
copyFileSync(resolve(root, "types/compat.d.ts"), resolve(destination, "compat.d.ts"));
writeFileSync(resolve(root, "dist/engine.d.mts"), 'export * from "./types/types/engine.js";\n');
copyFileSync(resolve(root, "types/adapter.d.mts"), resolve(root, "dist/adapter.d.mts"));
export const declarationArtifacts = [...outputs, "types/compat.d.ts", "engine.d.mts", "adapter.d.mts"];
