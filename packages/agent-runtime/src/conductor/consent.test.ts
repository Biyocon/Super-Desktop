import { describe, expect, it } from "vitest";
import { admitIntake, captureIntakeMaterial, ConductorRunId, createRun, executionEffectProfile, type ConductorRun, type ExecutionBaseline } from "@pi-desktop/conductor-runtime/engine";
import { ExecutionConsent, type ExecutionConsentAnswer } from "./consent.js";
import { ConductorJournal, type ConductorHost } from "./store.js";

const sessionId = "owned-consent-fixture" as NonNullable<ConductorRun["ownerSessionId"]>;
const baseline: ExecutionBaseline = { scopeVersion: "scope-1", planVersion: "plan-1", acceptanceVersion: "acceptance-1",
  allowedPaths: ["fixture.txt"], excludedPaths: [], rollbackReference: "sha256:fixture-source", qualityCommands: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup() {
  const original = createRun(ConductorRunId("CON-2026-9401"), { ownerSessionId: sessionId,
    admission: admitIntake({ purpose: "implementation", entry: "detective", rationale: "Consent unit fixture only." }, [
      captureIntakeMaterial("current-request", "Fixture owner instruction", { sessionId, eventIndex: 0 }),
    ]), objective: "Consent identity fixture", authority: { owner: "fixture-owner" } });
  // A boundary unit fixture, not evidence that A/B/C were evaluated.
  const run: ConductorRun = { ...original, currentStage: "devils-advocate" };
  let version = 0;
  let fingerprint = "sha256:source-one";
  let sourceCheck: (() => Promise<void>) | undefined;
  let commit: (() => Promise<void>) | undefined;
  const events: unknown[] = [];
  const transport: ConductorHost = { async call<T>(method: string, params?: unknown): Promise<T> {
    if (method === "conductorStore.create") return { lease: "fixture-lease", run: { schema: 1, runId: run.runId,
      sessionId, projectPath: "fixture-root", runtimeId: "fixture-runtime", checkpointHash: "a".repeat(64), version: 0, eventCount: 0, status: "running" } } as T;
    if (method !== "conductorStore.append") throw new Error("Unexpected host method");
    await commit?.();
    events.push(params);
    version++;
    return { version, currentVersion: version, duplicate: false } as T;
  } };
  const journal = await ConductorJournal.create(transport, "fixture-runtime", "fixture-root", {}, original);
  const ready = deferred<void>();
  const consent = new ExecutionConsent({ journal, validateSource: async () => { await sourceCheck?.(); return { fingerprint }; },
    changed: () => { if (consent.pending()) ready.resolve(); } });
  const controller = new AbortController();
  const pending = consent.request(run, structuredClone(baseline), executionEffectProfile(baseline), controller.signal);
  await ready.promise;
  const request = consent.pending();
  if (!request) throw new Error("Consent request missing");
  const answer: ExecutionConsentAnswer = { ...request, approve: true };
  return { consent, controller, pending, answer, events, run, setFingerprint: (value: string) => { fingerprint = value; },
    setCommit: (value: () => Promise<void>) => { commit = value; }, setSourceCheck: (value: () => Promise<void>) => { sourceCheck = value; } };
}

describe("Conductor exact owner execution consent", () => {
  it("waits for the exact owner answer and its durable acknowledgement, without caching authority", async () => {
    const fixture = await setup();
    expect(fixture.events).toHaveLength(1);
    const copy = fixture.consent.pending();
    if (!copy) throw new Error("Missing fixture request");
    copy.baseline.allowedPaths.push("unapproved.txt");
    expect(fixture.consent.pending()?.baseline.allowedPaths).toEqual(["fixture.txt"]);
    const committed = deferred<void>();
    fixture.setCommit(() => committed.promise);
    const answered = fixture.consent.answer(fixture.answer);
    await expect(fixture.consent.answer(fixture.answer)).rejects.toThrow("CONSENT_STALE");
    expect(fixture.events).toHaveLength(1);
    committed.resolve();
    await answered;
    expect(await fixture.pending).toEqual({ executionBaselineHash: fixture.answer.baselineHash, effectProfile: executionEffectProfile(baseline) });
    expect(fixture.consent.pending()).toBeUndefined();
    await expect(fixture.consent.answer(fixture.answer)).rejects.toThrow("CONSENT_STALE");
    expect(fixture.events).toHaveLength(2);
  });

  it("rejects wrong owner/run/request/baseline and a concurrent request without granting writes", async () => {
    const fixture = await setup();
    for (const field of ["sessionId", "runId", "requestId", "baselineHash"] as const) {
      await expect(fixture.consent.answer({ ...fixture.answer, [field]: "wrong" })).rejects.toThrow("CONSENT_STALE");
    }
    await expect(fixture.consent.request(fixture.run, baseline, executionEffectProfile(baseline), fixture.controller.signal)).rejects.toThrow("CONSENT_PENDING");
    await fixture.consent.answer({ ...fixture.answer, approve: false });
    expect(await fixture.pending).toBeNull();
  });

  it("fails closed when the source changes during owner wait", async () => {
    const fixture = await setup();
    const failed = expect(fixture.pending).rejects.toThrow("SOURCE_CHANGED");
    fixture.setFingerprint("sha256:external-change");
    await expect(fixture.consent.answer(fixture.answer)).rejects.toThrow("SOURCE_CHANGED");
    await failed;
    expect(fixture.events).toHaveLength(1);
    expect(fixture.consent.pending()).toBeUndefined();
  });

  it("does not authorize on an uncertain owner-decision journal commit", async () => {
    const fixture = await setup();
    const failed = expect(fixture.pending).rejects.toThrow("Owned acknowledgement failure");
    fixture.setCommit(async () => { throw new Error("Owned acknowledgement failure"); });
    await expect(fixture.consent.answer(fixture.answer)).rejects.toThrow("Owned acknowledgement failure");
    await failed;
  });

  it("cancels a pending owner wait and rejects every late answer", async () => {
    const fixture = await setup();
    const failed = expect(fixture.pending).rejects.toThrow("Owned cancel");
    fixture.controller.abort(new Error("Owned cancel"));
    await failed;
    await expect(fixture.consent.answer(fixture.answer)).rejects.toThrow("CONSENT_STALE");
    expect(fixture.events).toHaveLength(1);
  });

  it("settles an in-flight source check before cancellation completes, without a late approval", async () => {
    const fixture = await setup();
    const entered = deferred<void>(), release = deferred<void>();
    fixture.setSourceCheck(async () => { entered.resolve(); await release.promise; });
    const answered = fixture.consent.answer(fixture.answer);
    const answerFailed = expect(answered).rejects.toThrow("Owned cancel");
    const runFailed = expect(fixture.pending).rejects.toThrow("Owned cancel");
    await entered.promise;
    fixture.controller.abort(new Error("Owned cancel"));
    release.resolve();
    await Promise.all([answerFailed, runFailed]);
    expect(fixture.events).toHaveLength(1);
    expect(fixture.consent.pending()).toBeUndefined();
  });
});
