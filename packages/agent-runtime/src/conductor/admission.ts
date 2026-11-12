import { randomUUID } from "node:crypto";
import {
  admitIntake, canonicalAbsolute, captureIntakeMaterial, mintRunId, containsPath, createRun,
  parseRun, serializeRun, type ConductorRun,
} from "@pi-desktop/conductor-runtime/engine";
import { captureMandate, createQualityCatalog, type CapturedMandate, type QualityCatalog, type QualityCommandDefinition } from "@pi-desktop/conductor-runtime/adapter";
import type { ConductorHost } from "./store.js";

export type ConductorStartInput = {
  requestId: string;
  sessionId: string;
  projectPath: string;
  objective: string;
  purpose: "analysis" | "implementation";
  scope: string[];
  allowedPaths: string[];
  excludedPaths: string[];
  acceptanceCriteria: string[];
  materialPaths: string[];
  qualityCommands: QualityCommandDefinition[];
};
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CONDUCTOR_INPUT_INVALID");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 8192 || value.includes("\0")) throw new Error("CONDUCTOR_INPUT_INVALID");
  return value;
}
function texts(value: unknown, max: number, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > max) throw new Error("CONDUCTOR_INPUT_INVALID");
  const strings = value.map(text);
  if (new Set(strings).size !== strings.length) throw new Error("CONDUCTOR_INPUT_DUPLICATE");
  return strings;
}
export function parseStart(value: unknown): ConductorStartInput {
  const raw = object(value);
  const keys = ["requestId", "sessionId", "projectPath", "objective", "purpose", "scope", "allowedPaths", "excludedPaths", "acceptanceCriteria", "materialPaths", "qualityCommands"];
  if (Object.keys(raw).some(key => !keys.includes(key)) || !["analysis", "implementation"].includes(String(raw.purpose))) throw new Error("CONDUCTOR_INPUT_INVALID");
  const requestId = text(raw.requestId);
  if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error("CONDUCTOR_REQUEST_ID_INVALID");
  const catalog = createQualityCatalog(raw.qualityCommands);
  return {
    requestId, sessionId: text(raw.sessionId), projectPath: text(raw.projectPath), objective: text(raw.objective),
    purpose: raw.purpose as ConductorStartInput["purpose"], scope: texts(raw.scope, 64, 1),
    qualityCommands: catalog.bindings().map(binding => {
      const { id, image, argv, requiredGates, timeoutMs, outputLimitBytes } = catalog.command(binding, binding.requiredGates[0]);
      return { id, image, argv, requiredGates, timeoutMs, outputLimitBytes };
    }),
    allowedPaths: texts(raw.allowedPaths, 128), excludedPaths: texts(raw.excludedPaths, 128),
    acceptanceCriteria: texts(raw.acceptanceCriteria, 32, 1), materialPaths: texts(raw.materialPaths, 16),
  };
}
export async function admitRun(host: ConductorHost, input: ConductorStartInput, signal: AbortSignal = new AbortController().signal): Promise<{ run: ConductorRun; mandate: CapturedMandate; catalog: QualityCatalog; intake: Record<string, unknown> }> {
  signal.throwIfAborted();
  const catalog = createQualityCatalog(input.qualityCommands.map(({ id, image, argv, requiredGates, timeoutMs, outputLimitBytes }) => ({ id, image, argv, requiredGates, timeoutMs, outputLimitBytes })));
  const source = object(await host.call("conductorStore.captureSource", { sessionId: input.sessionId, allowedPaths: input.allowedPaths }));
  signal.throwIfAborted();
  if (typeof source.fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(source.fingerprint)) throw new Error("CONDUCTOR_SOURCE_RECEIPT_INVALID");
  const mandate = captureMandate(input.projectPath, {
    owner: input.sessionId, objective: input.objective, purpose: input.purpose, scope: input.scope,
    allowedPaths: input.allowedPaths, excludedPaths: input.excludedPaths,
    qualityCommandIds: catalog.bindings().map(binding => binding.id), sourceBaseline: source.fingerprint,
  }, catalog);
  const snapshot = mandate.snapshot();
  const sessionId = input.sessionId as NonNullable<ConductorRun["ownerSessionId"]>;
  // Event zero belongs to this immutable Conductor entry ledger, not to a
  // retroactively invented chat message or a provider conversation.
  const request = { ...input, sourceFingerprint: source.fingerprint, materialEncoding: "host-read-window-v1" };
  const materials = [captureIntakeMaterial("current-request", JSON.stringify(request, null, 2), { sessionId, eventIndex: 0 })];
  for (const path of input.materialPaths) {
    if (path.includes("\\") || path.startsWith("/") || path.includes(":") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("CONDUCTOR_MATERIAL_PATH_INVALID");
    if (!containsPath(snapshot.workspace, canonicalAbsolute(snapshot.workspace, path))) throw new Error("CONDUCTOR_MATERIAL_PATH_INVALID");
    signal.throwIfAborted();
    const toolCallId = randomUUID();
    let abort: Promise<unknown> | undefined;
    const cancel = () => { abort ??= host.call("tools.abort", { sessionId, toolCallId }); void abort.catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    let result: Record<string, unknown>;
    try {
      result = object(await host.call("tools.execute", { sessionId, toolCallId, toolName: "Read",
        args: { path, file_path: path, offset: 0, limit: 2000 }, mode: "agent", permissionScope: "inherit" }));
    } finally {
      signal.removeEventListener("abort", cancel);
      if (abort) await abort;
    }
    signal.throwIfAborted();
    if (result.ok !== true) throw new Error("CONDUCTOR_MATERIAL_READ_REJECTED");
    const content = object(result.content);
    if (content.root !== "workspace" || content.truncated !== false || content.offset !== 0 || content.lineCount !== content.totalLines
      || typeof content.content !== "string" || Buffer.byteLength(content.content) > 65536) throw new Error("CONDUCTOR_MATERIAL_INCOMPLETE");
    materials.push(captureIntakeMaterial(path, content.content));
  }
  signal.throwIfAborted();
  const run = createRun(mintRunId(), {
    ownerSessionId: sessionId, objective: input.objective, authority: { owner: sessionId },
    admission: admitIntake({ purpose: input.purpose, entry: "detective", ...(input.purpose === "analysis" ? { deliverable: "answer" } : {}),
      rationale: "Explicit owner Conductor entry; no inferred chat or Task authority.", scopeSources: ["current-request"] }, materials),
    scope: snapshot.scope, allowedPaths: snapshot.allowedPaths, excludedPaths: snapshot.excludedPaths, sourceBaseline: snapshot.sourceBaseline,
    acceptanceCriteria: input.acceptanceCriteria,
    ownerCapabilities: { allowedPaths: snapshot.allowedPaths, excludedPaths: snapshot.excludedPaths, qualityCommandIds: snapshot.qualityCommandIds },
    constraints: ["No external effects, shell, delegation, publication, merge or deployment.", "GO is not external execution authority."],
  });
  parseRun(serializeRun(run));
  return { run, mandate, catalog, intake: { request: input, mandate: snapshot, sourceFingerprint: source.fingerprint,
    provenance: { sessionId, eventIndex: 0, ledger: "conductor-entry" }, materials } };
}
