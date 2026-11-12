import { randomUUID } from "node:crypto";
import { canonicalAbsolute, drive, mintRunId, parseRun, resumeRun, serializeRun, ConductorRunId, type ConductorRun } from "@pi-desktop/conductor-runtime/engine";
import { captureMandate, createDispatcher, createQualityCatalog, createQualityRunner, type CapturedMandate, type QualityCatalog, type SpecialistProvider } from "@pi-desktop/conductor-runtime/adapter";
import type { SubagentThinkingLevel } from "@pi-desktop/shared";
import type { RuntimeProviderConfig } from "../provider-binding.js";
import { admitRun, object, parseStart } from "./admission.js";
import { ExecutionConsent, type ExecutionConsentAnswer } from "./consent.js";
import { createConductorProvider } from "./provider.js";
import { projectConductor, readConductorEvents } from "./projection.js";
import type { EngineProvenance } from "./loader.js";
import { ConductorJournal, loadConductorRun, type ConductorHost, type LoadedConductorRun } from "./store.js";

export type ConductorLaunch = {
  provider: RuntimeProviderConfig;
  thinkingLevel: SubagentThinkingLevel;
  dockerExecutable: string;
  scratchRoot: string;
};
type Active = {
  sessionId: string;
  runId: string;
  controller: AbortController;
  journal: ConductorJournal;
  consent: ExecutionConsent;
  done: Promise<void>;
  run: ConductorRun;
};
type Admission = { requestId: string; runId?: string; controller: AbortController; done: Promise<void>; release(): void };
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/\bCONDUCTOR_[A-Z_]+\b/)?.[0] ?? "CONDUCTOR_RUNTIME_FAILED";
}

/** Execution orchestration only: all process/gate decisions belong to drive(). */
export class ConductorService {
  private readonly active = new Map<string, Active>();
  private readonly admitting = new Map<string, Admission>();
  private readonly stopping = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly options: {
    host: ConductorHost;
    runtimeId: string;
    changed(sessionId: string, runId: string): void;
    provenance: EngineProvenance;
    fault(sessionId: string, runId: string, code: string): void;
  }) {}

  private available() { if (this.disposed) throw new Error("CONDUCTOR_RUNTIME_DISPOSED"); }
  owns(sessionId: string) {
    return this.stopping.has(sessionId) || this.admitting.has(sessionId) || [...this.active.values()].some(run => run.sessionId === sessionId);
  }
  private reserve(sessionId: string, requestId: string = randomUUID(), runId?: string) {
    this.available();
    if (this.owns(sessionId)) throw new Error("CONDUCTOR_SESSION_BUSY");
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    const reservation: Admission = { requestId, runId, controller: new AbortController(), done,
      release: () => { this.admitting.delete(sessionId); finished(); } };
    this.admitting.set(sessionId, reservation);
    return reservation;
  }

  async cancelAdmission(sessionId: string, requestId: string) {
    const reservation = this.admitting.get(sessionId);
    if (!reservation || reservation.requestId !== requestId) throw new Error("CONDUCTOR_ADMISSION_STALE");
    reservation.controller.abort(new Error("CONDUCTOR_CANCELLED"));
    await reservation.done;
    return { cancelled: true };
  }

  private admissionReady(reservation: Admission) {
    this.available();
    reservation.controller.signal.throwIfAborted();
  }

  async start(value: unknown, launch: ConductorLaunch): Promise<LoadedConductorRun> {
    const input = parseStart(value);
    const reservation = this.reserve(input.sessionId, input.requestId);
    let leasedRun: string | undefined;
    try {
      const admitted = await admitRun(this.options.host, input, reservation.controller.signal);
      const intake = { ...admitted.intake, engine: this.options.provenance };
      this.admissionReady(reservation);
      for (let attempt = 0; attempt < 16; attempt++) {
        const run = attempt === 0 ? admitted.run : { ...admitted.run, runId: mintRunId() };
        let journal: ConductorJournal;
        try { journal = await ConductorJournal.create(this.options.host, this.options.runtimeId, input.projectPath, intake, run); }
        catch (error) {
          if (errorCode(error) === "CONDUCTOR_RUN_EXISTS") continue;
          throw error;
        }
        leasedRun = run.runId;
        this.admissionReady(reservation);
        const initial = await loadConductorRun(this.options.host, input.sessionId, run.runId);
        this.admissionReady(reservation);
        this.launch(run, journal, admitted.mandate, admitted.catalog, launch);
        return initial;
      }
      throw new Error("CONDUCTOR_RUN_ID_EXHAUSTED");
    } catch (error) {
      if (leasedRun) await this.options.host.call("conductorStore.interruptRun", { sessionId: input.sessionId, runId: leasedRun });
      throw error;
    } finally { reservation.release(); }
  }

  async history(sessionId: string, runId: string) {
    const loaded = await loadConductorRun(this.options.host, sessionId, runId);
    const events = await readConductorEvents(this.options.host, loaded);
    const projection = projectConductor(loaded, events);
    const pending = this.active.get(runId)?.sessionId === sessionId ? this.active.get(runId)?.consent.pending() : undefined;
    const pendingConsent = loaded.index.status === "owner-waiting" && pending && events.some(({ event }) =>
      event.type === "execution-consent-request" && object(event.request).requestId === pending.requestId) ? pending : null;
    return { ...loaded, projection, pendingConsent };
  }

  async cancel(sessionId: string, runId: string) {
    const reservation = this.admitting.get(sessionId);
    if (reservation?.runId === runId) {
      reservation.controller.abort(new Error("CONDUCTOR_CANCELLED"));
      await reservation.done;
      return this.history(sessionId, runId);
    }
    const active = this.active.get(runId);
    if (!active) {
      const loaded = await this.history(sessionId, runId);
      if (loaded.index.status !== "owner-waiting" && loaded.index.status !== "interrupted") throw new Error("CONDUCTOR_RUN_NOT_ACTIVE");
      await this.options.host.call("conductorStore.interruptRun", { sessionId, runId });
      this.options.changed(sessionId, runId);
      return this.history(sessionId, runId);
    }
    if (active.sessionId !== sessionId) throw new Error("CONDUCTOR_RUN_NOT_ACTIVE");
    active.controller.abort(new Error("CONDUCTOR_CANCELLED"));
    await active.done;
    return this.history(sessionId, runId);
  }

  async authorize(answer: ExecutionConsentAnswer) {
    const active = this.active.get(answer.runId);
    if (!active || active.sessionId !== answer.sessionId) throw new Error("CONDUCTOR_CONSENT_STALE");
    await active.consent.answer(answer);
    return { acknowledged: true };
  }

  async resume(sessionId: string, runId: string, expectedVersion: number, launch: ConductorLaunch) {
    const reservation = this.reserve(sessionId, randomUUID(), runId);
    let leased = false;
    try {
      const loaded = await loadConductorRun(this.options.host, sessionId, runId);
      if (loaded.index.version !== expectedVersion || loaded.checkpoint.status !== "running") throw new Error("CONDUCTOR_RESUME_NOT_ALLOWED");
      const run = await resumeRun({ load: async () => loaded.checkpoint,
        save: async () => { throw new Error("CONDUCTOR_RESUME_LOAD_ONLY"); },
        delete: async () => { throw new Error("CONDUCTOR_RESUME_LOAD_ONLY"); } }, ConductorRunId(runId));
      const intake = object(loaded.intake);
      const input = parseStart(intake.request);
      if (input.sessionId !== sessionId || canonicalAbsolute(input.projectPath, ".") !== canonicalAbsolute(loaded.index.projectPath, ".") || typeof intake.sourceFingerprint !== "string") throw new Error("CONDUCTOR_RESUME_INTAKE_INVALID");
      const catalog = createQualityCatalog(input.qualityCommands);
      const mandate = captureMandate(input.projectPath, { owner: sessionId, objective: input.objective, purpose: input.purpose,
        scope: input.scope, allowedPaths: input.allowedPaths, excludedPaths: input.excludedPaths,
        qualityCommandIds: catalog.bindings().map(binding => binding.id), sourceBaseline: intake.sourceFingerprint }, catalog);
      mandate.validate(run);
      this.admissionReady(reservation);
      const journal = await ConductorJournal.resume(this.options.host, this.options.runtimeId, loaded,
        async () => { await this.options.host.call("conductorStore.validateSource", { sessionId, runId }); });
      leased = true;
      this.admissionReady(reservation);
      this.launch(run, journal, mandate, catalog, launch);
      return this.history(sessionId, runId);
    } catch (error) {
      if (leased) await this.options.host.call("conductorStore.interruptRun", { sessionId, runId });
      throw error;
    } finally { reservation.release(); }
  }

  private launch(run: ConductorRun, journal: ConductorJournal, mandate: CapturedMandate, catalog: QualityCatalog, launch: ConductorLaunch) {
    const controller = new AbortController();
    const changed = () => this.options.changed(journal.sessionId, journal.runId);
    const validateSource = async () => {
      const result = object(await this.options.host.call("conductorStore.validateSource", { sessionId: journal.sessionId, runId: journal.runId }));
      if (typeof result.fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(result.fingerprint)) throw new Error("CONDUCTOR_SOURCE_RECEIPT_INVALID");
      return { fingerprint: result.fingerprint };
    };
    const validateWorkspace = async (current: ConductorRun) => { mandate.validate(current); await validateSource(); };
    const consent = new ExecutionConsent({ journal, validateSource, changed });
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    const active: Active = { sessionId: journal.sessionId, runId: journal.runId, controller, journal, consent, done, run };
    const providers = new Set<Promise<unknown>>();
    const transport = createConductorProvider({ ownerSessionId: journal.sessionId, provider: launch.provider, thinkingLevel: launch.thinkingLevel,
      recordResult: async event => { await journal.append({ ...event }); changed(); } });
    const provider: SpecialistProvider = { dispatch(request) {
      const pending = transport.dispatch(request);
      providers.add(pending);
      void pending.then(() => providers.delete(pending), () => providers.delete(pending));
      return pending;
    } };
    const dispatcher = createDispatcher({ workspace: mandate.snapshot().workspace, signal: controller.signal, provider, host: {
      journal: async event => { await journal.append({ ...event }); changed(); },
      executeTool: (identity, signal) => journal.executeTool(identity, identity.name, identity.arguments, signal),
      authorizeExecution: (current, baseline, effects, signal) => consent.request(current, baseline, effects, signal),
      resolveBaseline: async (current, proposal) => mandate.resolveBaseline(current, proposal),
      validateWorkspace,
      // Conservative UTF-8 byte pricing. Actual provider usage is still checked
      // independently against every Harness critic attempt and run budget.
      countTokens: text => Buffer.byteLength(text, "utf8"),
      runQuality: createQualityRunner({ dockerExecutable: launch.dockerExecutable, scratchRoot: launch.scratchRoot,
        workspace: mandate.snapshot().workspace, catalog, validateWorkspace, resources: journal.qualityResources(launch.dockerExecutable) }),
    } });
    this.active.set(run.runId, active);
    // Start admission RPC can return before the first provider request. History
    // loading itself never enters this scheduling path.
    setImmediate(() => {
      void (async () => {
        try {
          controller.signal.throwIfAborted();
          const outcome = await drive(run, dispatcher, async checkpoint => {
            parseRun(serializeRun(checkpoint));
            await journal.append({ runId: run.runId, type: "checkpoint" }, checkpoint);
            active.run = checkpoint;
            changed();
          });
          active.run = outcome.run;
          await journal.append({ runId: run.runId, type: "outcome", kind: outcome.kind }, outcome.run,
            outcome.kind === "blocked" ? "owner-waiting" : "completed");
        } catch (error) {
          controller.abort(error);
          await Promise.allSettled([...providers]);
          try {
            await journal.append({ runId: run.runId, type: "runtime-error", code: errorCode(error) }, undefined,
              errorCode(error) === "CONDUCTOR_CANCELLED" ? "cancelled" : undefined);
            if (errorCode(error) !== "CONDUCTOR_CANCELLED") await this.options.host.call("conductorStore.interruptRun", { sessionId: journal.sessionId, runId: journal.runId });
          } catch {
            // An uncertain journal cannot be retried or converted into a pass.
            // Rotate/fence this run through the independent host lifecycle RPC.
            try { await this.options.host.call("conductorStore.interruptRun", { sessionId: journal.sessionId, runId: journal.runId }); }
            catch { this.options.fault(journal.sessionId, journal.runId, "CONDUCTOR_RECOVERY_FAILED"); }
          }
          this.options.fault(journal.sessionId, journal.runId, errorCode(error));
        } finally {
          controller.abort(new Error("CONDUCTOR_RUN_SETTLED"));
          await Promise.allSettled([...providers]);
          this.active.delete(run.runId);
          changed();
          finished();
        }
      })();
    });
  }

  async disposeSession(sessionId: string) {
    const existing = this.stopping.get(sessionId);
    if (existing) return existing;
    const stopped = this.stopOwned(sessionId, new Error("CONDUCTOR_OWNER_DISPOSED"));
    this.stopping.set(sessionId, stopped);
    try { await stopped; } finally { this.stopping.delete(sessionId); }
  }

  private async stopOwned(sessionId: string | undefined, reason: Error) {
    const admissions = [...this.admitting].filter(([owner]) => !sessionId || owner === sessionId).map(([, admission]) => admission);
    for (const admission of admissions) admission.controller.abort(reason);
    const runs = [...this.active.values()].filter(run => !sessionId || run.sessionId === sessionId);
    for (const run of runs) run.controller.abort(reason);
    await Promise.all([...runs.map(run => run.done), ...admissions.map(admission => admission.done)]);
  }

  async dispose(reason = new Error("CONDUCTOR_CANCELLED")) {
    this.disposed = true;
    await this.stopOwned(undefined, reason);
  }
}
