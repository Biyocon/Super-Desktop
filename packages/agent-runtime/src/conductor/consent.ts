import { randomUUID } from "node:crypto";
import {
  executionBaselineHash,
  executionEffectProfile,
  type ConductorRun,
  type ExecutionAuthorization,
  type ExecutionBaseline,
  type ExecutionEffectProfile,
} from "@pi-desktop/conductor-runtime/engine";
import type { ConductorJournal } from "./store.js";

export type ExecutionConsentRequest = {
  requestId: string;
  runId: string;
  sessionId: string;
  baselineHash: string;
  baseline: ExecutionBaseline;
  effectProfile: ExecutionEffectProfile;
  sourceFingerprint: string;
};
export type ExecutionConsentAnswer = {
  requestId: string;
  runId: string;
  sessionId: string;
  baselineHash: string;
  approve: boolean;
};
type Waiting = {
  request: ExecutionConsentRequest;
  answer(value: ExecutionConsentAnswer): Promise<void>;
};

/** Owner interaction only. Harness still validates and accepts/rejects Gate C. */
export class ExecutionConsent {
  private waiting: Waiting | undefined;

  private requesting = false;
  constructor(private readonly options: {
    journal: ConductorJournal;
    validateSource(): Promise<{ fingerprint: string }>;
    changed(): void;
  }) {}

  pending(): ExecutionConsentRequest | undefined {
    return this.waiting ? structuredClone(this.waiting.request) : undefined;
  }

  async answer(value: ExecutionConsentAnswer): Promise<void> {
    const waiting = this.waiting;
    if (!waiting || value.sessionId !== waiting.request.sessionId || value.runId !== waiting.request.runId
      || value.requestId !== waiting.request.requestId || value.baselineHash !== waiting.request.baselineHash
      || typeof value.approve !== "boolean") throw new Error("CONDUCTOR_CONSENT_STALE");
    await waiting.answer(structuredClone(value));
  }

  async request(run: ConductorRun, baseline: ExecutionBaseline, effectProfile: ExecutionEffectProfile, signal: AbortSignal): Promise<ExecutionAuthorization | null> {
    if (this.requesting) throw new Error("CONDUCTOR_CONSENT_PENDING");
    this.requesting = true;
    try { return await this.requestOnce(run, baseline, effectProfile, signal); }
    finally { this.requesting = false; }
  }

  private async requestOnce(run: ConductorRun, baseline: ExecutionBaseline, effectProfile: ExecutionEffectProfile, signal: AbortSignal): Promise<ExecutionAuthorization | null> {
    signal.throwIfAborted();
    if (this.waiting || run.runId !== this.options.journal.runId || run.ownerSessionId !== this.options.journal.sessionId
      || run.admission.purpose !== "implementation" || run.currentStage !== "devils-advocate"
      || JSON.stringify(effectProfile) !== JSON.stringify(executionEffectProfile(baseline))) {
      throw new Error("CONDUCTOR_CONSENT_INVALID");
    }
    const { fingerprint } = await this.options.validateSource();
    signal.throwIfAborted();
    const request: ExecutionConsentRequest = {
      requestId: randomUUID(), runId: run.runId, sessionId: this.options.journal.sessionId,
      baselineHash: executionBaselineHash(baseline), baseline: structuredClone(baseline),
      effectProfile: structuredClone(effectProfile), sourceFingerprint: fingerprint,
    };
    await this.options.journal.append({ runId: run.runId, type: "execution-consent-request", request }, undefined, "owner-waiting");
    signal.throwIfAborted();
    let resolve!: (value: ExecutionAuthorization | null) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<ExecutionAuthorization | null>((yes, no) => { resolve = yes; reject = no; });
    let answering = false;
    let answerTask: Promise<void> | undefined;
    const aborted = () => reject(signal.reason ?? new Error("CONDUCTOR_CONSENT_CANCELLED"));
    const waiting: Waiting = {
      request,
      answer: value => {
        if (answering || signal.aborted || this.waiting !== waiting) return Promise.reject(new Error("CONDUCTOR_CONSENT_STALE"));
        answering = true;
        answerTask = (async () => { try {
          const source = await this.options.validateSource();
          signal.throwIfAborted();
          if (source.fingerprint !== request.sourceFingerprint) throw new Error("CONDUCTOR_SOURCE_CHANGED");
          await this.options.journal.append({ runId: run.runId, type: "execution-consent-answer", requestId: request.requestId,
            baselineHash: request.baselineHash, sourceFingerprint: request.sourceFingerprint, approve: value.approve }, undefined, "running");
          signal.throwIfAborted();
          // Never cache consent or grants for another baseline, rework or restart.
          resolve(value.approve ? { executionBaselineHash: request.baselineHash, effectProfile: structuredClone(request.effectProfile) } : null);
        } catch (error) { reject(error); throw error; } })();
        return answerTask;
      },
    };
    this.waiting = waiting;
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    try {
      this.options.changed();
      return await completion;
    } finally {
      signal.removeEventListener("abort", aborted);
      if (this.waiting === waiting) this.waiting = undefined;
      if (answerTask) await answerTask.catch(() => undefined);
      this.options.changed();
    }
  }
}
