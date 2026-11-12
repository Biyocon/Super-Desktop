import { IPC, OAUTH_AUTH_KIND, type AppSettings, type ConductorAvailability, type ConductorHistory, type ConductorIndex, type SessionSummary } from "@pi-desktop/shared";
import { isRpcTimeoutError } from "@pi-desktop/shared";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { createSessionLaunchRuntime } from "../runtime/session-launch";
import { consent, entry, invalid, object, requestId, resume, runRef, session, text } from "../conductor/input";
import { conductorQualityCatalog, resolveConductorDocker, selectQualityCommands } from "../conductor/quality";
import type { IpcRegistrar } from "./types";

type Preparing = { requestId?: string; runId?: string; cancelled: boolean; entered: boolean; done: Promise<void>; sidecar: AgentSidecar };
export function registerConductorIpc(options: {
  registrar: IpcRegistrar;
  getMainWindow(): BrowserWindow | null;
  getHost(): HostProcess | null;
  getSidecar(): AgentSidecar | null;
  activeTurns: ReadonlyMap<string, unknown>;
  acquireSessionOperation(sessionId: string): Promise<() => void>;
  resolveRuntimeProvider: ReturnType<typeof createSessionLaunchRuntime>["resolveRuntimeProvider"];
}) {
  const preparing = new Map<string, Preparing>();
  function guard(event: IpcMainInvokeEvent) {
    options.registrar.assertMainWindowSender(event);
    const window = options.getMainWindow();
    if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) invalid("PERMISSION_DENIED");
  }
  function sidecar() { const current = options.getSidecar(); if (!current) invalid("CONDUCTOR_RUNTIME_UNAVAILABLE"); return current; }
  function register<T>(channel: string, handler: (value: unknown) => Promise<T>) {
    options.registrar.handleWithEvent(channel, async (event, value: unknown) => { guard(event); return handler(value); });
  }
  async function launch(input: ReturnType<typeof entry> | ReturnType<typeof resume>) {
    const { sessionId } = input;
    if (preparing.has(sessionId) || options.activeTurns.has(sessionId)) invalid("CONDUCTOR_SESSION_BUSY");
    const host = options.getHost(), current = sidecar();
    if (!host) invalid("CONDUCTOR_HOST_LOST");
    let finished!: () => void;
    const pending: Preparing = { requestId: "requestId" in input ? input.requestId : undefined,
      runId: "runId" in input ? input.runId : undefined, cancelled: false, entered: false, done: new Promise(resolve => { finished = resolve; }), sidecar: current };
    preparing.set(sessionId, pending);
    let release: (() => void) | undefined;
    function ready() {
      if (pending.cancelled) invalid("CONDUCTOR_CANCELLED");
      if (options.getHost() !== host || options.getSidecar() !== current) invalid("CONDUCTOR_HOST_LOST");
      if (options.activeTurns.has(sessionId)) invalid("CONDUCTOR_SESSION_BUSY");
    }
    try {
      release = await options.acquireSessionOperation(sessionId); ready();
      const available = await current.call<ConductorAvailability>("conductor.availability", {}); ready();
      if (!available.available) invalid(available.code);
      const { session: owner } = await host.call<{ session: SessionSummary | null }>("session.get", { id: sessionId }); ready();
      if (!owner || owner.id !== sessionId || (owner.source && owner.source !== "desktop") || !owner.projectPath) invalid("CONDUCTOR_OWNER_PROJECT_CHANGED");
      const projectPath = owner.projectPath;
      const qualityCommands = "qualityCommandIds" in input ? selectQualityCommands(input.qualityCommandIds) : [];
      // Resume uses the immutable admitted catalog, never renderer commands.
      if ("runId" in input) {
        const saved = await current.call<ConductorHistory>("conductor.history", { sessionId, runId: input.runId }); ready();
        if (saved.index.projectPath !== projectPath) invalid("CONDUCTOR_OWNER_PROJECT_CHANGED");
        const intake = object(saved.intake, ["request", "mandate", "sourceFingerprint", "provenance", "materials", "engine"]);
        const request = intake.request as { qualityCommands?: unknown } | undefined;
        if (!request || !Array.isArray(request.qualityCommands)) invalid("CONDUCTOR_RESUME_INTAKE_INVALID");
        for (const savedCommand of request.qualityCommands) {
          const command = object(savedCommand, ["id", "image", "argv", "requiredGates", "timeoutMs", "outputLimitBytes"]);
          const known = selectQualityCommands([text(command.id, 64)])[0];
          if (command.image !== known.image || command.timeoutMs !== known.timeoutMs || command.outputLimitBytes !== known.outputLimitBytes
            || JSON.stringify(command.argv) !== JSON.stringify(known.argv) || JSON.stringify(command.requiredGates) !== JSON.stringify(known.requiredGates)) invalid("CONDUCTOR_COMMAND_BINDING_INVALID");
          qualityCommands.push(known);
        }
      }
      const dockerExecutable = qualityCommands.length ? await resolveConductorDocker(qualityCommands) : "not-required"; ready();
      const settings = await host.call<AppSettings>("settings.get"); ready();
      const resolved = await options.resolveRuntimeProvider(owner, settings, {}, false); ready();
      const { session: latest } = await host.call<{ session: SessionSummary | null }>("session.get", { id: sessionId }); ready();
      if (!latest || latest.projectPath !== projectPath || latest.providerId !== owner.providerId || latest.modelId !== owner.modelId || latest.thinkingLevel !== owner.thinkingLevel) invalid("CONDUCTOR_OWNER_PROJECT_CHANGED");
      const scratch = await host.call<{ path: string }>("session.getScratchPath", { sessionId }); ready();
      current.setVendorAuthBindings(sessionId, resolved.provider.authKind === OAUTH_AUTH_KIND ? [{ providerId: resolved.provider.id }] : []);
      pending.entered = true;
      const request = "objective" in input ? (({ qualityCommandIds: _ids, ...value }) => ({ ...value, projectPath, qualityCommands }))(input) : undefined;
      const resolvedLaunch = { provider: resolved.runtimeProvider, thinkingLevel: resolved.thinkingLevel, dockerExecutable, scratchRoot: scratch.path };
      const result = "objective" in input
        ? await current.call<ConductorHistory>("conductor.start", { sessionId, request, launch: resolvedLaunch })
        : await current.call<ConductorHistory>("conductor.resume", { ...input, launch: resolvedLaunch });
      if (pending.cancelled) { await current.call("conductor.cancel", { sessionId, runId: result.index.runId }); invalid("CONDUCTOR_CANCELLED"); }
      return result;
    } catch (error) {
      if (pending.entered && isRpcTimeoutError(error)) {
        try {
          const cancelExact = async (runId: string) => {
            try { await current.call("conductor.cancel", { sessionId, runId }); }
            catch (failure) { if (!(failure instanceof Error) || failure.message !== "CONDUCTOR_RUN_NOT_ACTIVE") throw failure; }
          };
          if ("objective" in input) {
            try { await current.call("conductor.cancelAdmission", { sessionId, requestId: input.requestId }); }
            catch (failure) { if (!(failure instanceof Error) || failure.message !== "CONDUCTOR_ADMISSION_STALE") throw failure; }
            const saved = await current.call<{ runs: ConductorIndex[] }>("conductor.list", { sessionId });
            for (const run of saved.runs) if (run.sessionId === sessionId && run.requestId === input.requestId
              && (run.status === "running" || run.status === "owner-waiting")) await cancelExact(run.runId);
          } else await cancelExact(input.runId);
        } catch (failure) {
          throw Object.assign(new Error("CONDUCTOR_RECOVERY_FAILED", { cause: failure }), { errorCode: "CONDUCTOR_RECOVERY_FAILED" });
        }
      }
      throw error;
    } finally { release?.(); preparing.delete(sessionId); finished(); }
  }
  register(IPC.invoke.conductorAvailability, async value => { object(value ?? {}, []); return sidecar().call<ConductorAvailability>("conductor.availability", {}); });
  register(IPC.invoke.conductorCatalog, async value => { object(value ?? {}, []); return { commands: conductorQualityCatalog() }; });
  register(IPC.invoke.conductorStart, async value => launch(entry(value)));
  register(IPC.invoke.conductorResume, async value => launch(resume(value)));
  register(IPC.invoke.conductorList, async value => sidecar().call<{ runs: ConductorIndex[] }>("conductor.list", session(value)));
  register(IPC.invoke.conductorHistory, async value => sidecar().call<ConductorHistory>("conductor.history", runRef(value)));
  register(IPC.invoke.conductorAuthorize, async value => sidecar().call<{ acknowledged: true }>("conductor.authorize", consent(value)));
  register(IPC.invoke.conductorCancelAdmission, async value => {
    const raw = object(value, ["sessionId", "requestId"]);
    const input = { sessionId: text(raw.sessionId, 256), requestId: requestId(raw.requestId) };
    const pending = preparing.get(input.sessionId);
    if (!pending || pending.requestId !== input.requestId) return sidecar().call("conductor.cancelAdmission", input);
    pending.cancelled = true;
    if (pending.entered) {
      try { await pending.sidecar.call("conductor.cancelAdmission", input); }
      catch (error) { if (!String(error).includes("CONDUCTOR_ADMISSION_STALE")) throw error; }
    }
    await pending.done;
    return { cancelled: true };
  });
  register(IPC.invoke.conductorCancel, async value => {
    const input = runRef(value), pending = preparing.get(input.sessionId);
    if (pending?.runId === input.runId) {
      pending.cancelled = true;
      if (pending.entered) await pending.sidecar.call("conductor.cancel", input);
      await pending.done;
      return sidecar().call<ConductorHistory>("conductor.history", input);
    }
    return sidecar().call<ConductorHistory>("conductor.cancel", input);
  });
}
