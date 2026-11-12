import { describe, expect, it } from "vitest";
import { admitIntake, captureIntakeMaterial, ConductorRunId, createRun, type ConductorRun } from "@pi-desktop/conductor-runtime/engine";
import { ConductorJournal, loadConductorRun, type ConductorHost } from "./store.js";

const sessionId = "owned-fixture" as NonNullable<ConductorRun["ownerSessionId"]>;
function run() {
  return createRun(ConductorRunId("CON-2026-9001"), {
    ownerSessionId: sessionId,
    admission: admitIntake({ purpose: "implementation", entry: "detective", rationale: "Journal fixture." }, [
      captureIntakeMaterial("current-request", "Fixture request", { sessionId, eventIndex: 0 }),
    ]), objective: "Check journal acknowledgement", authority: { owner: "fixture-user" },
  });
}
function index() {
  return { schema: 1, runId: "CON-2026-9001", sessionId, projectPath: "fixture-root", version: 0,
    eventCount: 0, status: "running", runtimeId: "fixture-runtime", checkpointHash: "a".repeat(64) };
}
function host(boundary: (method: string, params: unknown) => Promise<unknown>): ConductorHost {
  return { async call<T>(method: string, params?: unknown) { return await boundary(method, params) as T; } };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture expected record");
  return value as Record<string, unknown>;
}

describe("Conductor runtime journal", () => {
  it("serializes acknowledged commits and captures caller payloads before queuing", async () => {
    let release: (value: unknown) => void = () => { throw new Error("not initialized"); };
    const held = new Promise<unknown>(resolve => { release = resolve; });
    const requests: Record<string, unknown>[] = [];
    let observedFirst: () => void = () => undefined;
    const firstStarted = new Promise<void>(resolve => { observedFirst = resolve; });
    const transport = host(async (method, params) => {
      if (method === "conductorStore.create") return { run: index(), lease: "lease" };
      const request = record(params);
      requests.push(request);
      if (requests.length === 1) { observedFirst(); return held; }
      return { version: 2, currentVersion: 2, duplicate: false };
    });
    const journal = await ConductorJournal.create(transport, "fixture-runtime", "fixture-root", {}, run());
    const first = journal.append({ runId: journal.runId, worker: "one" });
    const mutable = { runId: journal.runId, worker: "two" };
    const second = journal.append(mutable);
    mutable.worker = "forged";
    await firstStarted;
    expect(requests).toHaveLength(1);
    expect(requests[0].expectedVersion).toBe(0);
    release({ version: 1, currentVersion: 1, duplicate: false });
    await Promise.all([first, second, journal.settled()]);
    expect(requests).toHaveLength(2);
    expect(requests[1].expectedVersion).toBe(1);
    expect(record(requests[1].event).worker).toBe("two");
    expect(requests[0].eventId).not.toBe(requests[1].eventId);
  });

  it("never advances after an uncertain or malformed commit acknowledgement", async () => {
    let appends = 0;
    const transport = host(async method => {
      if (method === "conductorStore.create") return { run: index(), lease: "lease" };
      appends++;
      return { version: 2, currentVersion: 2, duplicate: false };
    });
    const journal = await ConductorJournal.create(transport, "fixture-runtime", "fixture-root", {}, run());
    await expect(journal.append({ runId: journal.runId })).rejects.toThrow("CONDUCTOR_JOURNAL_ACK_INVALID");
    await expect(journal.append({ runId: journal.runId })).rejects.toThrow("CONDUCTOR_JOURNAL_ACK_INVALID");
    expect(appends).toBe(1);
  });

  it("loads only the motor checkpoint and rejects wrong owners without starting work", async () => {
    const methods: string[] = [];
    const transport = host(async method => { methods.push(method); return { run: index(), checkpoint: run(), intake: { fixture: true } }; });
    const loaded = await loadConductorRun(transport, sessionId, "CON-2026-9001");
    expect(loaded.checkpoint.currentStage).toBe("detective");
    expect(methods).toEqual(["conductorStore.load"]);
    await expect(loadConductorRun(transport, "different-owner", "CON-2026-9001")).rejects.toThrow("CONDUCTOR_STORE_RESPONSE_INVALID");
    await expect(ConductorJournal.resume(transport, "new-runtime", loaded, async () => { throw new Error("must not reach source validation"); })).rejects.toThrow("CONDUCTOR_RESUME_NOT_ALLOWED");
    expect(methods).toEqual(["conductorStore.load", "conductorStore.load"]);
  });
});
