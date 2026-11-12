import type { ConductorConsentAnswer, ConductorEntry, ConductorResume, ConductorRunRef } from "@pi-desktop/shared";

export function invalid(code = "CONDUCTOR_INPUT_INVALID"): never {
  throw Object.assign(new Error(code), { errorCode: code });
}
export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !keys.includes(key))) invalid();
  return raw;
}
export function text(value: unknown, max = 8192): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max || value.includes("\0")) invalid();
  return value;
}
function texts(value: unknown, max: number, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > max) invalid();
  const result = value.map(item => text(item));
  if (new Set(result).size !== result.length) invalid("CONDUCTOR_INPUT_DUPLICATE");
  return result;
}
export function requestId(value: unknown): string {
  const id = text(value, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) invalid();
  return id;
}
export function session(value: unknown): { sessionId: string } {
  const raw = object(value, ["sessionId"]);
  return { sessionId: text(raw.sessionId, 256) };
}
export function runRef(value: unknown): ConductorRunRef {
  const raw = object(value, ["sessionId", "runId"]);
  const runId = text(raw.runId, 13);
  if (!/^CON-\d{4}-\d{4}$/.test(runId)) invalid();
  return { sessionId: text(raw.sessionId, 256), runId };
}
export function resume(value: unknown): ConductorResume {
  const raw = object(value, ["sessionId", "runId", "expectedVersion"]);
  if (!Number.isSafeInteger(raw.expectedVersion) || Number(raw.expectedVersion) < 1) invalid();
  return { ...runRef({ sessionId: raw.sessionId, runId: raw.runId }), expectedVersion: Number(raw.expectedVersion) };
}
export function consent(value: unknown): ConductorConsentAnswer {
  const raw = object(value, ["sessionId", "runId", "requestId", "baselineHash", "approve"]);
  const baselineHash = text(raw.baselineHash, 80);
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(baselineHash) || typeof raw.approve !== "boolean") invalid();
  return { ...runRef({ sessionId: raw.sessionId, runId: raw.runId }), requestId: requestId(raw.requestId), baselineHash, approve: raw.approve };
}
export function entry(value: unknown): ConductorEntry {
  const raw = object(value, ["requestId", "sessionId", "objective", "purpose", "scope", "allowedPaths", "excludedPaths", "acceptanceCriteria", "materialPaths", "qualityCommandIds"]);
  if (raw.purpose !== "analysis" && raw.purpose !== "implementation") invalid();
  const result: ConductorEntry = {
    requestId: requestId(raw.requestId), sessionId: text(raw.sessionId, 256), objective: text(raw.objective), purpose: raw.purpose,
    scope: texts(raw.scope, 64, 1), allowedPaths: texts(raw.allowedPaths, 128), excludedPaths: texts(raw.excludedPaths, 128),
    acceptanceCriteria: texts(raw.acceptanceCriteria, 32, 1), materialPaths: texts(raw.materialPaths, 16), qualityCommandIds: texts(raw.qualityCommandIds, 32),
  };
  if (result.purpose === "analysis" && (result.allowedPaths.length || result.qualityCommandIds.length)) invalid();
  if (result.purpose === "implementation" && (!result.allowedPaths.length || !result.qualityCommandIds.length)) invalid();
  for (const path of [...result.scope, ...result.allowedPaths, ...result.excludedPaths, ...result.materialPaths]) {
    if (path.includes("\\") || path.includes(":") || /[\0*?]/.test(path) || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) invalid();
  }
  return result;
}
