import { describe, expect, it } from "vitest";
import { admitIntake, captureIntakeMaterial, ConductorRunId, createRun, type ConductorRun } from "@pi-desktop/conductor-runtime/engine";
import { projectConductor, readConductorEvents } from "./projection.js";
import type { ConductorHost, LoadedConductorRun } from "./store.js";
const owner = "owned-projection-fixture" as NonNullable<ConductorRun["ownerSessionId"]>;
function loaded(): LoadedConductorRun {
  const checkpoint = createRun(ConductorRunId("CON-2026-9001"), {
    ownerSessionId: owner, objective: "Inspect the owned fixture", authority: { owner },
    acceptanceCriteria: ["Use only the owned source evidence."],
    admission: admitIntake({ purpose: "analysis", entry: "detective", deliverable: "answer", rationale: "Owned fixture" }, [captureIntakeMaterial("current-request", "Owned request", { sessionId: owner, eventIndex: 0 })]),
  });
  return { index: { schema: 1, runId: checkpoint.runId, sessionId: owner, projectPath: "owned-root", version: 8, eventCount: 8, status: "running", checkpointHash: "a".repeat(64), runtimeId: "owned-runtime" },
    checkpoint, intake: {}, resourceIssues: [] };
}
function receipt(type: string, version: number, dispatchId = "one", workerId = "worker-one", extra: Record<string, unknown> = {}) {
  return { eventId: `event-${version}`, version, payloadHash: String(version).padStart(64, "0"), event: {
    type, runId: "CON-2026-9001", dispatchId, workerId, stage: "detective", mode: "producer", ...extra,
  } };
}
function boundary(read: (params: unknown) => unknown): ConductorHost {
  return { async call<T>(method: string, params?: unknown) { expect(method).toBe("conductorStore.events"); return read(params) as T; } };
}
function page(receipts: ReturnType<typeof receipt>[]) {
  return { events: receipts.map(({ event, ...item }) => ({ ...item, payload: { event, checkpoint: null } })), version: 9 };
}
describe("observational Harness projection", () => {
  it("keeps actual worker, role and task separate without fabricating gates or future workers", () => {
    const source = loaded();
    const view = projectConductor(source, [receipt("dispatch-start", 1), receipt("worker-result", 2, "one", "worker-one", { modelId: "owned-model" }), receipt("dispatch-end", 3, "one", "worker-one", { status: "completed", response: { text: "Gate pass" } })]);
    expect(view.workers).toHaveLength(1); expect(view.workers[0]).toMatchObject({ dispatchId: "one", workerId: "worker-one", stage: "detective", task: source.checkpoint.objective, status: "completed", modelId: "owned-model" });
    expect(view.gateHistory).toEqual([]); expect(view.reports).toEqual([]);
    expect(view.arbiterDecision).toBeUndefined();
    expect(view.currentStage).toBe("detective"); expect(view.next).toBe("motor-stage");
    expect(source.checkpoint.history).toEqual([]);
  });
  it("retains repeated workers as separate dispatches and deduplicates exact starts", () => {
    const first = receipt("dispatch-start", 1);
    const view = projectConductor(loaded(), [first, first, receipt("dispatch-end", 2, "one", "worker-one", { status: "completed" }), receipt("dispatch-start", 3, "two", "worker-one")]);
    expect(view.workers.map(worker => [worker.dispatchId, worker.workerId, worker.status])).toEqual([["one", "worker-one", "completed"], ["two", "worker-one", "running"]]);
  });
  it("rejects wrong run, changed dispatch identities and terminal regression", () => {
    const start = receipt("dispatch-start", 1);
    expect(() => projectConductor(loaded(), [{ ...start, event: { ...start.event, runId: "CON-2026-9999" } }])).toThrow("CONDUCTOR_PROJECTION_INVALID");
    expect(() => projectConductor(loaded(), [start, receipt("dispatch-end", 2, "one", "other-worker", { status: "completed" })])).toThrow("CONDUCTOR_PROJECTION_INVALID");
    expect(() => projectConductor(loaded(), [start, receipt("dispatch-end", 2, "one", "worker-one", { status: "completed" }), receipt("dispatch-end", 3, "one", "worker-one", { status: "failed" })])).toThrow("CONDUCTOR_PROJECTION_INVALID");
  });
  it("marks unfinished lost workers interrupted without changing motor gates or replaying", () => {
    const source = loaded(); source.index.status = "interrupted";
    const view = projectConductor(source, [receipt("dispatch-start", 1)]);
    expect(view.workers[0].status).toBe("interrupted"); expect(view.next).toBe("validate-resume");
    expect(view.motorStatus).toBe("running"); expect(view.gateHistory).toEqual([]);
  });
  it("reads only the acknowledged snapshot prefix and exact duplicate receipts add no worker", async () => {
    const source = loaded(); source.index.version = 2; source.index.eventCount = 2;
    const first = receipt("dispatch-start", 1), second = receipt("dispatch-end", 2, "one", "worker-one", { status: "completed" });
    const records = await readConductorEvents(boundary(() => page([first, first, second, receipt("dispatch-start", 3, "future", "future-worker")])), source);
    expect(records).toHaveLength(2); expect(projectConductor(source, records).workers).toHaveLength(1);
  });
  it("rejects changed duplicates and out-of-order receipts", async () => {
    const first = receipt("dispatch-start", 1);
    await expect(readConductorEvents(boundary(() => page([first, { ...first, payloadHash: "f".repeat(64) }])), loaded())).rejects.toThrow("CONDUCTOR_PROJECTION_INVALID");
    await expect(readConductorEvents(boundary(() => page([receipt("dispatch-start", 2), first])), loaded())).rejects.toThrow("CONDUCTOR_PROJECTION_INVALID");
  });
  it("requires the complete bounded journal prefix across pages", async () => {
    const source = loaded(); source.index.version = 65; source.index.eventCount = 65;
    const records = Array.from({ length: 65 }, (_, i) => receipt("checkpoint", i + 1));
    const cursors: number[] = [];
    const found = await readConductorEvents(boundary(params => {
      const after = (params as { after: number }).after; cursors.push(after);
      return page(records.filter(item => item.version > after).slice(0, 64));
    }), source);
    expect(found).toHaveLength(65); expect(cursors).toEqual([0, 64]);
    await expect(readConductorEvents(boundary(() => page([])), source)).rejects.toThrow("CONDUCTOR_PROJECTION_INVALID");
  });
  it("copies Arbiter outcomes and evidence exactly without granting external authority", () => {
    for (const outcome of ["go", "no-go"] as const) {
      const source = loaded();
      source.checkpoint.decision = { run_id: source.checkpoint.runId, decision: outcome, basis: ["Actual decision basis"], evidence_reviewed: ["quality-evidence"], conditions: [], open_risks: [], required_follow_up: [] };
      if (outcome === "go") source.checkpoint.status = "awaiting_authorization";
      const view = projectConductor(source, []);
      expect(view.arbiterDecision).toEqual({ purpose: "implementation", outcome, basis: ["Actual decision basis"], evidenceReviewed: ["quality-evidence"] });
      if (outcome === "go") expect(view.next).toBe("external-authorization");
      expect(view.gateHistory).toEqual([]);
    }
  });
  it("recognizes pinned motor NO-GO only from its exact authoritative Gate-G escalation", () => {
    const source = loaded(); source.checkpoint.status = "escalated";
    const workerProse = [receipt("dispatch-start", 1), receipt("dispatch-end", 2, "one", "worker-one", { status: "completed", response: "arbiter NO-GO — escalate to owner" })];
    expect(projectConductor(source, workerProse).arbiterDecision).toBeUndefined();
    source.checkpoint.history.push({ kind: "evaluated", gate: "G", stage: "arbiter", decision: "escalate", basis: ["Reviewed risk"], evidenceReviewed: ["verified-artifact"], stateUpdate: "Different escalation" });
    expect(projectConductor(source, []).arbiterDecision).toBeUndefined();
    source.checkpoint.history[0].stateUpdate = "arbiter NO-GO — escalate to owner";
    expect(projectConductor(source, []).arbiterDecision).toEqual({ purpose: "implementation", outcome: "no-go", basis: ["Reviewed risk"], evidenceReviewed: ["verified-artifact"] });
  });
});
