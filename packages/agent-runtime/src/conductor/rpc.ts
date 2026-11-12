import type { ModelAuth } from "@earendil-works/pi-ai";
import { OAUTH_AUTH_KIND } from "@pi-desktop/shared";
import type { RuntimeProviderConfig } from "../provider-binding.js";
import { normalizeSupportedThinkingLevels, normalizeThinkingLevel } from "../sidecar-config.js";
import { conductorLoader } from "./loader.js";
import type { ConductorHost } from "./store.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CONDUCTOR_INPUT_INVALID");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 8192 || value.includes("\0")) throw new Error("CONDUCTOR_INPUT_INVALID");
  return value;
}
function fields(raw: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(raw).some(key => !allowed.includes(key))) throw new Error("CONDUCTOR_INPUT_INVALID");
}

/** Dedicated sidecar entry, never a generic chat prompt or Task registry entry. */
export function conductorRpc(options: {
  host: ConductorHost;
  runtimeId: string;
  notify(method: string, params: unknown): void;
  chatBusy(sessionId: string): boolean;
}) {
  const createLoader = () => conductorLoader({ ...options,
    changed: (sessionId, runId) => options.notify("conductor.changed", { sessionId, runId }),
    fault: (sessionId, runId, code) => options.notify("conductor.fault", { sessionId, runId, code }),
  });
  let loader = createLoader();
  const busy = new Set<string>();
  function launch(value: unknown, sessionId: string) {
    const raw = object(value);
    fields(raw, ["provider", "thinkingLevel", "dockerExecutable", "scratchRoot"]);
    const input = object(raw.provider);
    // This is a host-resolved provider binding, not an agent/plugin identity.
    if ("resolveAuth" in input || "extensionAgentKey" in input) throw new Error("CONDUCTOR_PROVIDER_INVALID");
    for (const key of ["id", "name", "modelId"]) text(input[key]);
    if (typeof input.apiKey !== "string" || (!input.apiKey && input.authKind !== "none" && input.authKind !== OAUTH_AUTH_KIND)) throw new Error("CONDUCTOR_PROVIDER_INVALID");
    const provider: RuntimeProviderConfig = {
      ...input as RuntimeProviderConfig,
      supportsReasoning: input.supportsReasoning === true,
      supportedThinkingLevels: normalizeSupportedThinkingLevels(input.supportedThinkingLevels, input.supportsReasoning === true),
    };
    if (provider.authKind === OAUTH_AUTH_KIND) provider.resolveAuth = () => options.host.call<ModelAuth>("provider.resolveAuth", { sessionId, providerId: provider.id });
    return { provider, thinkingLevel: normalizeThinkingLevel(raw.thinkingLevel),
      dockerExecutable: text(raw.dockerExecutable), scratchRoot: text(raw.scratchRoot) };
  }
  return {
    owns(sessionId: string) { return busy.has(sessionId) || loader.owns(sessionId); },
    async handle(method: string, value: unknown): Promise<unknown> {
      try {
        const raw = object(value);
        if (method === "conductor.availability") { fields(raw, []); return loader.availability(); }
        if (method === "conductor.hostLost") {
          fields(raw, []);
          await loader.dispose(new Error("CONDUCTOR_HOST_LOST"));
          // Explicit future entry gets a fresh lazy service; no run is resumed.
          loader = createLoader();
          return { revoked: true };
        }
        if (method === "conductor.dispose") { fields(raw, []); await loader.dispose(); return { ok: true }; }
        if (method === "conductor.list") {
          fields(raw, ["sessionId"]);
          return options.host.call("conductorStore.list", { sessionId: text(raw.sessionId) });
        }
        const sessionId = text(raw.sessionId);
        if (method === "conductor.start" || method === "conductor.resume") {
          fields(raw, method === "conductor.start" ? ["sessionId", "request", "launch"] : ["sessionId", "runId", "expectedVersion", "launch"]);
          if (options.chatBusy(sessionId) || busy.has(sessionId)) throw new Error("CONDUCTOR_SESSION_BUSY");
          const resolved = launch(raw.launch, sessionId);
          const service = await loader.get();
          // Guard again after asynchronous engine import.
          if (options.chatBusy(sessionId) || busy.has(sessionId)) throw new Error("CONDUCTOR_SESSION_BUSY");
          busy.add(sessionId);
          try {
            if (method === "conductor.start") {
              if (object(raw.request).sessionId !== sessionId) throw new Error("CONDUCTOR_OWNER_MISMATCH");
              return await service.start(raw.request, resolved);
            }
            if (!Number.isSafeInteger(raw.expectedVersion) || Number(raw.expectedVersion) < 1) throw new Error("CONDUCTOR_INPUT_INVALID");
            return await service.resume(sessionId, text(raw.runId), Number(raw.expectedVersion), resolved);
          } finally { busy.delete(sessionId); }
        }
        const service = await loader.get();
        if (method === "conductor.cancelAdmission") {
          fields(raw, ["sessionId", "requestId"]);
          return service.cancelAdmission(sessionId, text(raw.requestId));
        }
        if (method === "conductor.history") {
          fields(raw, ["sessionId", "runId"]);
          return service.history(sessionId, text(raw.runId));
        }
        if (method === "conductor.cancel") {
          fields(raw, ["sessionId", "runId"]);
          return service.cancel(sessionId, text(raw.runId));
        }
        if (method === "conductor.authorize") {
          fields(raw, ["sessionId", "runId", "requestId", "baselineHash", "approve"]);
          if (typeof raw.approve !== "boolean") throw new Error("CONDUCTOR_INPUT_INVALID");
          return service.authorize({ sessionId, runId: text(raw.runId), requestId: text(raw.requestId), baselineHash: text(raw.baselineHash), approve: raw.approve });
        }
        throw new Error("CONDUCTOR_METHOD_INVALID");
      } catch (error) {
        const code = error instanceof Error ? error.message.match(/\bCONDUCTOR_[A-Z_]+\b/)?.[0] : undefined;
        throw Object.assign(new Error(code ?? "CONDUCTOR_RUNTIME_FAILED"), { errorCode: code ?? "CONDUCTOR_RUNTIME_FAILED" });
      }
    },
    async disposeSession(sessionId: string) { if (loader.owns(sessionId)) await (await loader.get()).disposeSession(sessionId); },
    dispose: () => loader.dispose(),
  };
}
