// Actual packaged sidecar and Rust transport; only the HTTP provider is a fixture.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AgentSidecar } from "../../host-runtime/dist/agent-sidecar.js";
import { HostProcess } from "../../host-runtime/dist/host-process.js";

const [binary, scratch] = process.argv.slice(2);
assert.ok(binary && scratch, "Explicit owned host binary and scratch required");
const root = await mkdtemp(join(resolve(scratch), "conductor-bundle-"));
let requests = 0;
const server = createServer(async (request, response) => {
  for await (const _chunk of request) { /* Consume the fixture request only. */ }
  requests++;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: "ordinary fixture response" }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({ id: "owned-chat", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
});
const outcomes = [];
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const guard = join(root, "network-guard.mjs");
  await writeFile(guard, `const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin!==${JSON.stringify(origin)})throw new Error('Non-fixture network denied');return original(input,init)};`);
  for (const state of ["present", "missing", "incompatible"]) {
    const directory = join(root, state), home = join(directory, "home"), repo = join(directory, "repo"), runtime = join(directory, "runtime");
    await mkdir(home, { recursive: true }); await mkdir(repo);
    await writeFile(join(repo, "fixture.txt"), "before\n");
    await cp(fileURLToPath(new URL("../../agent-runtime/dist-bundle/", import.meta.url)), runtime, { recursive: true, dereference: false });
    const engineRoot = join(runtime, "node_modules", "@pi-desktop", "conductor-runtime");
    if (state === "missing") await rm(engineRoot, { recursive: true });
    if (state === "incompatible") await writeFile(join(engineRoot, "dist", "engine.mjs"), "throw new Error('Unverified bytes must not execute');\n");
    const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH,
      HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: home, TMP: home,
      HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost" };
    let sidecarStderr = "";
    const sidecar = new AgentSidecar({ launch: { command: process.execPath, args: ["--import", pathToFileURL(guard).href, join(runtime, "sidecar.js")], env, cwd: home }, onStderr(text) { sidecarStderr += text; } });
    const host = new HostProcess({ binaryPath: resolve(binary), dataDir: join(directory, "data"), env, onStderr() {} });
    const events = [];
    sidecar.setHost(host);
    sidecar.onNotification((method, params) => events.push({ method, params }));
    try {
      await host.call("app.handshake", { protocolVersion: 11 });
      assert.equal((await sidecar.call("sidecar.health").catch(error => { throw new Error(`${error.message}: ${sidecarStderr}`); })).ok, true);
      const availability = await sidecar.call("conductor.availability");
      assert.equal(availability.available, state === "present");
      const { session } = await host.call("session.create", { title: `Owned ${state} engine`, mode: "agent", projectPath: repo });
      const provider = { id: "owned-provider", name: "Fixture", baseUrl: `${origin}/v1`, modelId: "fixture-model", apiKey: "task-owned-fixture-key",
        apiStyle: "openai-completions", authKind: "api-key", supportsReasoning: false, supportedThinkingLevels: ["off"] };
      const before = requests;
      if (state !== "present") {
        assert.equal(availability.code, state === "missing" ? "CONDUCTOR_ENGINE_UNAVAILABLE" : "CONDUCTOR_ENGINE_INCOMPATIBLE");
        await assert.rejects(sidecar.call("conductor.start", { sessionId: session.id,
          request: { requestId: randomUUID(), sessionId: session.id, projectPath: repo, objective: "No unavailable-engine fallback.", purpose: "analysis", scope: ["fixture.txt"], allowedPaths: [], excludedPaths: [], acceptanceCriteria: ["No fallback."], materialPaths: [], qualityCommands: [] },
          launch: { provider, thinkingLevel: "off", dockerExecutable: join(root, "unused-docker"), scratchRoot: root } }), error => error.errorCode === availability.code);
        assert.equal(requests, before, "Unavailable engine must not fall back to a provider request");
        assert.deepEqual((await sidecar.call("conductor.list", { sessionId: session.id })).runs, []);
      }
      const shell = process.platform === "win32" ? { id: "windows-powershell", label: "Windows PowerShell", dialect: "powershell", available: true, isDefault: true }
        : { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
      await sidecar.call("agent.prompt", { sessionId: session.id, provider, commandShell: shell, projectPath: repo, scratchDir: home, mode: "agent", thinkingLevel: "off", content: "Reply with the local fixture answer; do not call tools." });
      const deadline = Date.now() + 15000;
      let completed = false;
      while (Date.now() < deadline) {
        const status = await sidecar.call("agent.getStatus", { sessionId: session.id });
        if (requests === before + 1 && status.status.isRunning === false && JSON.stringify(events).includes("ordinary fixture response")) { completed = true; break; }
        await delay(10);
      }
      assert.equal(completed, true, `Ordinary chat must still complete with ${state} engine`);
      assert.equal(requests, before + 1);
      assert.equal(await readFile(join(repo, "fixture.txt"), "utf8"), "before\n");
      outcomes.push({ state, availability, ordinaryChatCompleted: true, conductorFallbackRequests: 0 });
    } finally { await sidecar.dispose(); await host.dispose(); }
  }
  await writeFile(join(resolve(scratch), "conductor-bundle-result.json"), JSON.stringify({ fixtureOnly: true, desktopWiringAccepted: false, outcomes }, null, 2) + "\n");
  console.log("CONDUCTOR_BUNDLE_ACCEPTANCE_PASS: isolated actual bundle; missing/tampered engines block before execution; ordinary loopback chat completes in all three cases");
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
