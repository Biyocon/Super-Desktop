import { expect, it } from "vitest";
import { ConductorFence } from "./conductor-fence.js";
import type { SidecarHostLink } from "./agent-sidecar.js";

function fixture(call: SidecarHostLink["call"]): SidecarHostLink {
  return { call, onNotification: () => () => {}, onExit: () => () => {} };
}
it("does not touch host state for ordinary chat-only processes", async () => {
  const fence = new ConductorFence();
  fence.close(); await fence.settled();
});
it("rejects a different process identity before reaching the host", async () => {
  const fence = new ConductorFence();
  const host = fixture(async () => { throw new Error("must not reach host"); });
  await expect(fence.acquire(host, "conductorStore.create", { runtimeId: new ConductorFence().runtimeId })).rejects.toThrow("ID_MISMATCH");
});
it("fences only its process and refuses acquisition after close", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  const host = fixture(async <T>(method: string, params: unknown) => { calls.push({ method, params }); return {} as T; });
  const fence = new ConductorFence();
  await fence.acquire(host, "conductorStore.create", { runtimeId: fence.runtimeId });
  fence.close(); fence.close(); await fence.settled();
  expect(calls).toEqual([{ method: "conductorStore.create", params: { runtimeId: fence.runtimeId } }, { method: "conductorStore.interrupt", params: { runtimeId: fence.runtimeId } }]);
  await expect(fence.acquire(host, "conductorStore.resume", { runtimeId: fence.runtimeId })).rejects.toThrow("CLOSED");
});
it("fences again after a delayed create acknowledgement, without replaying it", async () => {
  let acknowledge!: (value: unknown) => void;
  const methods: string[] = [];
  const host = fixture(<T>(method: string) => {
    methods.push(method);
    return method === "conductorStore.create" ? new Promise<T>(resolve => { acknowledge = resolve; }) : Promise.resolve({} as T);
  });
  const fence = new ConductorFence();
  const creation = fence.acquire(host, "conductorStore.create", { runtimeId: fence.runtimeId });
  fence.close();
  expect(methods).toEqual(["conductorStore.create", "conductorStore.interrupt"]);
  acknowledge({}); await creation; await fence.settled();
  expect(methods).toEqual(["conductorStore.create", "conductorStore.interrupt", "conductorStore.interrupt"]);
});
it("surfaces failed fencing instead of claiming cleanup", async () => {
  const fence = new ConductorFence();
  const host = fixture(async <T>(method: string) => { if (method.endsWith("interrupt")) throw new Error("owned fixture unavailable"); return {} as T; });
  await fence.acquire(host, "conductorStore.resume", { runtimeId: fence.runtimeId });
  fence.close(); await expect(fence.settled()).rejects.toThrow("RECOVERY_FAILED");
});
it("detaches only an acquired host and never retries it against its replacement", async () => {
  const fence = new ConductorFence(), calls: string[] = [];
  const old = fixture(async <T>(method: string) => { calls.push(`old:${method}`); return {} as T; });
  const next = fixture(async <T>(method: string) => { calls.push(`new:${method}`); return {} as T; });
  await fence.acquire(old, "conductorStore.create", { runtimeId: fence.runtimeId });
  await fence.detach(old);
  await fence.acquire(next, "conductorStore.resume", { runtimeId: fence.runtimeId });
  fence.close(); await fence.settled();
  expect(calls).toEqual(["old:conductorStore.create", "old:conductorStore.interrupt", "new:conductorStore.resume", "new:conductorStore.interrupt"]);
});
it("reports a dead-host detach once without touching ordinary unacquired hosts", async () => {
  const fence = new ConductorFence();
  const unused = fixture(async () => { throw new Error("ordinary host must not be touched"); });
  await fence.detach(unused);
  const dead = fixture(async <T>(method: string) => { if (method.endsWith("interrupt")) throw new Error("owned dead host"); return {} as T; });
  await fence.acquire(dead, "conductorStore.create", { runtimeId: fence.runtimeId });
  await expect(fence.detach(dead)).rejects.toThrow("RECOVERY_FAILED");
  fence.close(); await fence.settled();
});
