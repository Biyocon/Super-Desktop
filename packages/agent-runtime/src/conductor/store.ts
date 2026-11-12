import { randomUUID } from "node:crypto";
import {
  parseRun,
  serializeRun,
  validateResumable,
  type ConductorRun,
} from "@pi-desktop/conductor-runtime/engine";
import type { DispatchIdentity, QualityRequest, QualityResource, ContainerResources } from "@pi-desktop/conductor-runtime/adapter";
import { conductorHostToolName, conductorToolArguments } from "./tools.js";

export interface ConductorHost {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export type ConductorLifecycle =
  | "running" | "owner-waiting" | "interrupted"
  | "completed" | "failed" | "cancelled";

export type ConductorIndex = {
  schema: 1;
  runId: string;
  sessionId: string;
  projectPath: string;
  version: number;
  eventCount: number;
  status: ConductorLifecycle;
  checkpointHash: string;
  runtimeId: string;
};

export type LoadedConductorRun = {
  resourceIssues: Array<{ resourceId: string; code: "CONDUCTOR_CONTAINER_CLEANUP_FAILED"; creationUncertain: boolean }>;
  index: ConductorIndex;
  checkpoint: ConductorRun;
  intake: unknown;
};

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CONDUCTOR_STORE_RESPONSE_INVALID");
  }
  return value as Record<string, unknown>;
}

function indexFrom(value: unknown, sessionId: string, runId: string): ConductorIndex {
  const index = object(value);
  if (index.schema !== 1 || index.runId !== runId || index.sessionId !== sessionId
    || typeof index.projectPath !== "string" || typeof index.runtimeId !== "string"
    || typeof index.checkpointHash !== "string" || !/^[a-f0-9]{64}$/.test(index.checkpointHash)
    || !Number.isSafeInteger(index.version) || Number(index.version) < 0
    || !Number.isSafeInteger(index.eventCount) || Number(index.eventCount) < 0
    || !["running", "owner-waiting", "interrupted", "completed", "failed", "cancelled"].includes(String(index.status))
    || "lease" in index) throw new Error("CONDUCTOR_STORE_RESPONSE_INVALID");
  return {
    schema: 1, runId, sessionId, projectPath: index.projectPath,
    version: Number(index.version), eventCount: Number(index.eventCount),
    checkpointHash: index.checkpointHash, runtimeId: index.runtimeId,
    status: index.status as ConductorLifecycle,
  };
}

function admitted(value: unknown, sessionId: string, runId: string) {
  const response = object(value);
  const index = indexFrom(response.run, sessionId, runId);
  if (typeof response.lease !== "string" || !response.lease) throw new Error("CONDUCTOR_STORE_LEASE_MISSING");
  return { index, lease: response.lease };
}

/** Observational only: parsing and loading never dispatch or acquire a lease. */
export async function loadConductorRun(host: ConductorHost, sessionId: string, runId: string): Promise<LoadedConductorRun> {
  const response = object(await host.call("conductorStore.load", { sessionId, runId }));
  const index = indexFrom(response.run, sessionId, runId);
  const checkpoint = parseRun(typeof response.checkpoint === "string" ? response.checkpoint : JSON.stringify(response.checkpoint));
  if (checkpoint.runId !== runId || checkpoint.ownerSessionId !== sessionId) throw new Error("CONDUCTOR_STORE_OWNER_MISMATCH");
  const issues = response.resourceIssues ?? [];
  if (!Array.isArray(issues)) throw new Error("CONDUCTOR_STORE_RESPONSE_INVALID");
  const resourceIssues = issues.map(value => {
    const issue = object(value);
    if (typeof issue.resourceId !== "string" || issue.code !== "CONDUCTOR_CONTAINER_CLEANUP_FAILED" || typeof issue.creationUncertain !== "boolean") throw new Error("CONDUCTOR_STORE_RESPONSE_INVALID");
    return { resourceId: issue.resourceId, code: "CONDUCTOR_CONTAINER_CLEANUP_FAILED" as const, creationUncertain: issue.creationUncertain };
  });
  return { index, checkpoint, intake: response.intake, resourceIssues };
}

/** A lease-scoped journal, not an engine or a provider request queue. */
export class ConductorJournal {
  private tail: Promise<void> = Promise.resolve();
  private version: number;

  private constructor(
    private readonly host: ConductorHost,
    readonly sessionId: string,
    readonly runId: string,
    private readonly lease: string,
    version: number,
  ) { this.version = version; }

  static async create(host: ConductorHost, runtimeId: string, projectPath: string, intake: unknown, run: ConductorRun) {
    const checkpoint = parseRun(serializeRun(run));
    if (!checkpoint.ownerSessionId) throw new Error("CONDUCTOR_STORE_OWNER_REQUIRED");
    const result = admitted(await host.call("conductorStore.create", {
      sessionId: checkpoint.ownerSessionId, runId: checkpoint.runId, runtimeId,
      projectPath, intake, checkpoint: serializeRun(checkpoint),
    }), checkpoint.ownerSessionId, checkpoint.runId);
    return new ConductorJournal(host, result.index.sessionId, result.index.runId, result.lease, result.index.version);
  }

  static async resume(
    host: ConductorHost, runtimeId: string, loaded: LoadedConductorRun,
    validateSource: (loaded: LoadedConductorRun) => Promise<void>,
  ) {
    const checkpoint = parseRun(serializeRun(loaded.checkpoint));
    validateResumable(checkpoint);
    if (loaded.index.status !== "interrupted" || checkpoint.runId !== loaded.index.runId
      || checkpoint.ownerSessionId !== loaded.index.sessionId) throw new Error("CONDUCTOR_RESUME_NOT_ALLOWED");
    await validateSource(loaded);
    const result = admitted(await host.call("conductorStore.resume", {
      sessionId: loaded.index.sessionId, runId: loaded.index.runId, runtimeId,
      expectedVersion: loaded.index.version, validatedCheckpointHash: loaded.index.checkpointHash,
    }), loaded.index.sessionId, loaded.index.runId);
    return new ConductorJournal(host, result.index.sessionId, result.index.runId, result.lease, result.index.version);
  }

  append(event: Record<string, unknown>, checkpoint?: ConductorRun, status?: Exclude<ConductorLifecycle, "interrupted">): Promise<void> {
    // Capture caller data now; a later mutation must not change the queued event.
    const captured = structuredClone(event);
    const saved = checkpoint ? parseRun(serializeRun(checkpoint)) : undefined;
    if (captured.runId !== this.runId || saved && (saved.runId !== this.runId || saved.ownerSessionId !== this.sessionId)) {
      return Promise.reject(new Error("CONDUCTOR_JOURNAL_IDENTITY_INVALID"));
    }
    const eventId = randomUUID();
    this.tail = this.tail.then(async () => {
      const expected = this.version;
      const response = object(await this.host.call("conductorStore.append", {
        sessionId: this.sessionId, runId: this.runId, lease: this.lease,
        eventId, expectedVersion: expected, event: captured,
        checkpoint: saved ? serializeRun(saved) : null, status: status ?? null,
      }));
      if (response.version !== expected + 1 || response.currentVersion !== expected + 1
        || response.duplicate !== false) throw new Error("CONDUCTOR_JOURNAL_ACK_INVALID");
      this.version = expected + 1;
    });
    // A failed acknowledgement poisons this lease's queue. No later action is
    // allowed to proceed on an uncertain commit; explicit recovery must load it.
    return this.tail;
  }

  async executeTool(identity: DispatchIdentity, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (identity.runId !== this.runId) throw new Error("CONDUCTOR_JOURNAL_IDENTITY_INVALID");
    await this.settled();
    signal.throwIfAborted();
    const arguments_ = conductorToolArguments(name, args);
    const toolCallId = randomUUID();
    let abort: Promise<unknown> | undefined;
    const cancel = () => {
      abort ??= this.host.call("tools.abort", { sessionId: this.sessionId, toolCallId });
      // Observe immediately; surface the failure after the owned call settles.
      void abort.catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.host.call("tools.execute", {
        sessionId: this.sessionId, toolCallId, toolName: conductorHostToolName(name),
        args: arguments_, mode: "agent", permissionScope: "inherit",
        conductor: { runId: this.runId, lease: this.lease, dispatchId: identity.dispatchId,
          workerId: identity.workerId, stage: identity.stage },
      });
      if (abort) await abort;
      signal.throwIfAborted();
      return result;
    } finally {
      signal.removeEventListener("abort", cancel);
      if (abort) await abort;
    }
  }

  qualityResources(dockerExecutable: string): ContainerResources {
    return {
      create: async (request: QualityRequest, probeArgv?: string[]): Promise<QualityResource> => {
        if (request.runId !== this.runId) throw new Error("CONDUCTOR_JOURNAL_IDENTITY_INVALID");
        await this.settled();
        return this.host.call<QualityResource>("conductorStore.createQuality", {
          sessionId: this.sessionId, dockerExecutable, commandId: request.binding.id, definitionHash: request.binding.definitionHash,
          conductor: { runId: this.runId, lease: this.lease, dispatchId: request.dispatchId, workerId: request.workerId, stage: request.stage },
          probeArgv: probeArgv ?? null,
        });
      },
      release: resource => this.host.call("conductorStore.releaseQuality", {
        sessionId: this.sessionId, runId: this.runId, resourceId: resource.resourceId,
      }).then(() => undefined),
    };
  }

  settled(): Promise<void> { return this.tail; }
}
