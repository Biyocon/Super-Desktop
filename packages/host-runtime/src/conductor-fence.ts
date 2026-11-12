import { randomUUID } from "node:crypto";
import type { SidecarHostLink } from "./agent-sidecar.js";

/** Process-scoped lease/resource fencing only, never an engine/gate decision. */
export class ConductorFence {
  readonly runtimeId = randomUUID();
  private readonly hosts = new Set<SidecarHostLink>();
  private readonly acquiring = new Map<Promise<unknown>, SidecarHostLink>();
  private closing = false;
  private settlement: Promise<void> = Promise.resolve();
  private failure: Error | undefined;

  async acquire<T>(host: SidecarHostLink, method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closing) throw new Error("CONDUCTOR_RUNTIME_CLOSED");
    if (params.runtimeId !== this.runtimeId) throw new Error("CONDUCTOR_RUNTIME_ID_MISMATCH");
    this.hosts.add(host);
    const pending = host.call<T>(method, params);
    this.acquiring.set(pending, host);
    try { return await pending; }
    finally { this.acquiring.delete(pending); }
  }

  private async fence(hosts: SidecarHostLink[], acquiring: Promise<unknown>[]) {
    const first = await Promise.allSettled(hosts.map(host => host.call("conductorStore.interrupt", { runtimeId: this.runtimeId })));
    await Promise.allSettled(acquiring);
    const final = acquiring.length ? await Promise.allSettled(hosts.map(host => host.call("conductorStore.interrupt", { runtimeId: this.runtimeId }))) : first;
    if (final.some(result => result.status === "rejected")) throw new Error("CONDUCTOR_RECOVERY_FAILED");
  }

  /** Detach only this host; its failure is reported now, not retried on a new host. */
  async detach(host: SidecarHostLink) {
    if (!this.hosts.delete(host)) return;
    await this.fence([host], [...this.acquiring].filter(([, owner]) => owner === host).map(([pending]) => pending));
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    this.settlement = this.fence([...this.hosts], [...this.acquiring.keys()]).catch(error => {
      this.failure = error instanceof Error ? error : new Error("CONDUCTOR_RECOVERY_FAILED");
    });
  }

  async settled() {
    await this.settlement;
    if (this.failure) throw this.failure;
  }
}
