import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ConductorService, type ConductorLaunch } from "./service.js";
import { inspectEngine } from "./loader.js";
import type { ConductorHost } from "./store.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
// Host acknowledgements are the external persistence/tool boundary. The real
// admission parser, source mandate, intake and service lifecycle stay in place.
function fixture() {
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "conductor-intake-"));
  writeFileSync(join(root, "fixture.txt"), "before\n");
  const entered = deferred<void>(), aborted = deferred<void>(), read = deferred<unknown>(), abortAck = deferred<unknown>();
  const methods: string[] = [];
  const host: ConductorHost = { async call<T>(method: string) {
    methods.push(method);
    if (method === "conductorStore.captureSource") return { fingerprint: `sha256:${"a".repeat(64)}` } as T;
    if (method === "tools.execute") { entered.resolve(); return await read.promise as T; }
    if (method === "tools.abort") { aborted.resolve(); read.resolve({ ok: false }); return await abortAck.promise as T; }
    throw new Error(`Unexpected external call: ${method}`);
  } };
  const service = new ConductorService({ host, runtimeId: randomUUID(), provenance: inspectEngine(), changed() {}, fault() {} });
  const input = { requestId: randomUUID(), sessionId: "owned-intake", projectPath: root, purpose: "analysis", objective: "Read owned fixture only.",
    scope: ["fixture.txt"], allowedPaths: [], excludedPaths: [], acceptanceCriteria: ["No changes."], materialPaths: ["fixture.txt"], qualityCommands: [] };
  const launch: ConductorLaunch = { provider: { id: "unused", name: "Unused", modelId: "unused", apiKey: "owned-unused", supportsReasoning: false, supportedThinkingLevels: ["off"] }, thinkingLevel: "off", dockerExecutable: join(root, "unused-docker"), scratchRoot: root };
  return { service, input, launch, entered, aborted, abortAck, methods, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

it("cancels selected-material Read, waits its abort acknowledgement, and never creates a run/provider", async () => {
  const f = fixture();
  try {
    const start = f.service.start(f.input, f.launch).catch(error => error);
    await f.entered.promise;
    expect(f.service.owns(f.input.sessionId)).toBe(true);
    const cancel = f.service.cancelAdmission(f.input.sessionId, f.input.requestId);
    await f.aborted.promise;
    expect(f.service.owns(f.input.sessionId)).toBe(true);
    f.abortAck.resolve({ aborted: true });
    expect(await cancel).toEqual({ cancelled: true });
    expect(String(await start)).toContain("CONDUCTOR_CANCELLED");
    expect(f.service.owns(f.input.sessionId)).toBe(false);
    expect(f.methods).toEqual(["conductorStore.captureSource", "tools.execute", "tools.abort"]);
  } finally { await f.service.dispose(); f.cleanup(); }
});
it("dispose aborts and awaits admission before allowing no future starts", async () => {
  const f = fixture();
  try {
    const start = f.service.start(f.input, f.launch).catch(error => error);
    await f.entered.promise;
    const disposal = f.service.dispose();
    await f.aborted.promise;
    f.abortAck.resolve({ aborted: true });
    await disposal;
    expect(String(await start)).toContain("CONDUCTOR_CANCELLED");
    await expect(f.service.start(f.input, f.launch)).rejects.toThrow("DISPOSED");
    expect(f.methods).not.toContain("conductorStore.create");
  } finally { f.cleanup(); }
});
it("rejects stale/wrong-session admission cancellation without aborting the current Read", async () => {
  const f = fixture();
  try {
    const start = f.service.start(f.input, f.launch).catch(error => error);
    await f.entered.promise;
    await expect(f.service.cancelAdmission(f.input.sessionId, randomUUID())).rejects.toThrow("STALE");
    await expect(f.service.cancelAdmission("other", f.input.requestId)).rejects.toThrow("STALE");
    expect(f.methods).not.toContain("tools.abort");
    const disposal = f.service.dispose(); await f.aborted.promise; f.abortAck.resolve({}); await disposal; await start;
  } finally { f.cleanup(); }
});
it("rejects a second entry for the same owner while admission is pending", async () => {
  const f = fixture();
  try {
    const start = f.service.start(f.input, f.launch).catch(error => error);
    await f.entered.promise;
    await expect(f.service.start({ ...f.input, requestId: randomUUID() }, f.launch)).rejects.toThrow("BUSY");
    const disposal = f.service.dispose(); await f.aborted.promise; f.abortAck.resolve({}); await disposal; await start;
    expect(f.methods.filter(method => method === "tools.execute")).toHaveLength(1);
  } finally { f.cleanup(); }
});
it("owner disposal waits for Read cleanup, blocks parallel entry, and leaves other owners alone", async () => {
  const f = fixture();
  try {
    const start = f.service.start(f.input, f.launch).catch(error => error);
    await f.entered.promise;
    await f.service.disposeSession("other-owner");
    expect(f.methods).not.toContain("tools.abort");
    const disposal = f.service.disposeSession(f.input.sessionId);
    await f.aborted.promise;
    await expect(f.service.start({ ...f.input, requestId: randomUUID() }, f.launch)).rejects.toThrow("BUSY");
    f.abortAck.resolve({ aborted: true });
    await disposal;
    expect(String(await start)).toContain("OWNER_DISPOSED");
    expect(f.service.owns(f.input.sessionId)).toBe(false);
    expect(f.methods).not.toContain("conductorStore.create");
  } finally { await f.service.dispose(); f.cleanup(); }
});
