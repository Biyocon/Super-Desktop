import type { ConductorAvailability, ConductorConsentRequest, ConductorEntry, ConductorHistory, ConductorIndex, ConductorQualityCommand } from "@pi-desktop/shared";
import type { ConductorClient } from "./client";

export type ConductorViewState = {
  runs: ConductorIndex[];
  selectedRunId: string | null;
  history: ConductorHistory | null;
  availability: ConductorAvailability | null;
  commands: ConductorQualityCommand[];
  loading: boolean;
  busy: boolean;
  admissionRequest: string | null;
  error: string | null;
};

/** UI observation and explicit actions only; no gate decisions or execution on reads. */
export class ConductorHistoryController {
  private state: ConductorViewState = {
    runs: [], selectedRunId: null, history: null, availability: null, commands: [],
    loading: false, busy: false, admissionRequest: null, error: null,
  };
  private listeners = new Set<() => void>();
  private generation = 0;
  private selection = 0;
  private disconnect: Array<() => void> = [];
  private pending: Promise<void> | null = null;
  private dirty = false;
  private locked = false;
  private cancellingAdmission = false;
  private versions = new Map<string, number>();
  constructor(readonly sessionId: string, private client: ConductorClient) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ConductorViewState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private fail(error: unknown) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    this.update({ error: typeof code === "string" && /^[A-Z][A-Z0-9_]{1,100}$/.test(code) ? code : "ERROR" });
  }
  connect() {
    const epoch = ++this.generation;
    const current = () => epoch === this.generation;
    this.disconnect = [
      this.client.onChanged(event => { if (current() && event.sessionId === this.sessionId) void this.refresh(); }),
      this.client.onFault(event => {
        if (!current() || event.sessionId !== this.sessionId) return;
        this.fail({ code: event.code }); void this.refresh();
      }),
    ];
    void this.initialize(epoch);
    return () => {
      if (!current()) return;
      ++this.generation;
      for (const unsubscribe of this.disconnect) unsubscribe();
      this.disconnect = [];
      // Disposal is observational: the host, not the panel, owns active runs.
    };
  }
  private async initialize(epoch: number) {
    try {
      const [availability, catalog] = await Promise.all([this.client.availability(), this.client.catalog()]);
      if (epoch !== this.generation) return;
      this.update({ availability, commands: catalog.commands });
    } catch (error) { if (epoch === this.generation) this.fail(error); }
    if (epoch === this.generation) await this.refresh();
  }
  refresh = (): Promise<void> => {
    this.dirty = true;
    if (this.pending) return this.pending;
    const epoch = this.generation;
    const work = async () => {
      this.update({ loading: true });
      try {
        while (this.dirty && epoch === this.generation) {
          this.dirty = false;
          const selectedEpoch = this.selection;
          const result = await this.client.list(this.sessionId);
          if (epoch !== this.generation) return;
          const runs = result.runs.filter(run => run.sessionId === this.sessionId).map(run => {
            const minimum = this.versions.get(run.runId) ?? 0;
            if (run.version < minimum) return this.state.runs.find(old => old.runId === run.runId) ?? run;
            this.versions.set(run.runId, run.version); return run;
          });
          this.update({ runs });
          if (selectedEpoch !== this.selection) { this.dirty = true; continue; }
          const runId = this.state.selectedRunId ?? runs.at(-1)?.runId ?? null;
          this.update({ selectedRunId: runId });
          if (!runId) { this.update({ history: null }); continue; }
          const history = await this.client.history({ sessionId: this.sessionId, runId });
          if (epoch !== this.generation) return;
          if (selectedEpoch !== this.selection || runId !== this.state.selectedRunId) { this.dirty = true; continue; }
          this.accept(history, runId);
        }
      } catch (error) { if (epoch === this.generation) this.fail(error); }
      finally { if (epoch === this.generation) this.update({ loading: false }); }
    };
    this.pending = work().finally(() => {
      this.pending = null;
      if (this.dirty && this.disconnect.length) void this.refresh();
    });
    return this.pending;
  };
  private accept(history: ConductorHistory, runId: string) {
    if (history.index.sessionId !== this.sessionId || history.index.runId !== runId) throw new Error("History owner mismatch");
    const minimum = this.versions.get(runId) ?? 0;
    if (history.index.version < minimum) return;
    const old = this.state.history;
    if (old?.index.runId === runId && old.index.version === history.index.version && old.index.checkpointHash !== history.index.checkpointHash) throw new Error("Conflicting history version");
    this.versions.set(runId, history.index.version);
    this.update({ history });
  }
  select = (runId: string) => {
    if (this.state.selectedRunId === runId) return;
    ++this.selection;
    this.update({ selectedRunId: runId, history: null });
    void this.refresh();
  };
  private async action(work: () => Promise<void>) {
    if (this.locked) return;
    this.locked = true;
    const epoch = this.generation;
    this.update({ busy: true, error: null });
    try { await work(); }
    catch (error) { if (epoch === this.generation) this.fail(error); }
    finally {
      this.locked = false;
      if (epoch === this.generation) {
        this.update({ busy: false, admissionRequest: null });
        await this.refresh();
      }
    }
  }
  start = (entry: Omit<ConductorEntry, "sessionId" | "requestId">) => this.action(async () => {
    const requestId = crypto.randomUUID(), epoch = this.generation;
    this.update({ admissionRequest: requestId });
    const created = await this.client.start({ ...entry, sessionId: this.sessionId, requestId });
    if (epoch !== this.generation) return;
    if (created.index.sessionId !== this.sessionId) throw new Error("Created owner mismatch");
    ++this.selection;
    this.versions.set(created.index.runId, created.index.version);
    this.update({ selectedRunId: created.index.runId, history: null });
    // The initial receipt is not a full projection. Read acknowledged history.
  });
  cancelAdmission = async () => {
    const requestId = this.state.admissionRequest, epoch = this.generation;
    if (!requestId || this.cancellingAdmission) return;
    this.cancellingAdmission = true;
    try { await this.client.cancelAdmission({ sessionId: this.sessionId, requestId }); }
    catch (error) { if (epoch === this.generation) this.fail(error); }
    finally { this.cancellingAdmission = false; }
  };
  resume = () => this.action(async () => {
    const history = this.state.history;
    if (!history) return;
    await this.client.resume({ sessionId: this.sessionId, runId: history.index.runId, expectedVersion: history.index.version });
  });
  cancel = () => this.action(async () => {
    const history = this.state.history;
    if (history) await this.client.cancel({ sessionId: this.sessionId, runId: history.index.runId });
  });
  authorize = (request: ConductorConsentRequest, approve: boolean) => this.action(async () => {
    const pending = this.state.history?.pendingConsent;
    if (!pending || request.sessionId !== this.sessionId || request.runId !== pending.runId || request.requestId !== pending.requestId || request.baselineHash !== pending.baselineHash) throw new Error("Consent snapshot changed");
    await this.client.authorize({ sessionId: this.sessionId, runId: request.runId, requestId: request.requestId, baselineHash: request.baselineHash, approve });
    // No optimistic approval or cached grant; the next view is a host read.
  });
}
