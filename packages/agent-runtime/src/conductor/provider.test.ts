import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitIntake, captureIntakeMaterial, ConductorRunId, createRun, type ConductorRun } from "@pi-desktop/conductor-runtime/engine";
import type { ProviderDispatch } from "@pi-desktop/conductor-runtime/adapter";
import type { RuntimeProviderConfig } from "../provider-binding.js";
import { createConductorProvider, type ConductorWorkerResult } from "./provider.js";
import { conductorToolArguments, conductorTools } from "./tools.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) await close(); });

const ownerSessionId = "owner-fixture" as NonNullable<ConductorRun["ownerSessionId"]>;
function request(overrides: Partial<ProviderDispatch> = {}): ProviderDispatch {
  const run = createRun(ConductorRunId("CON-2026-9201"), {
    ownerSessionId,
    admission: admitIntake({ purpose: "implementation", entry: "detective", rationale: "Local provider transport fixture." }, [
      captureIntakeMaterial("current-request", "Inspect fixture only.", { sessionId: ownerSessionId, eventIndex: 0 }),
    ]),
    objective: "Inspect fixture only.", scope: ["fixture.txt"], allowedPaths: ["fixture.txt"], excludedPaths: [],
    authority: { owner: "fixture-user" }, acceptanceCriteria: ["Read the fixture."],
    budget: { maxReworkPerGate: 2, maxRalphRounds: 0, maxOwnerReassessmentsPerGate: 2,
      maxCriticInputTokensPerAttempt: 24000, maxCriticOutputTokensPerAttempt: 16000, maxCriticTokensPerRun: 120000 },
  });
  return { runId: run.runId, stage: "detective", mode: "specialist", dispatchId: "dispatch-fixture", workerId: "worker-fixture",
    input: run, run, tools: ["read", "grep", "glob", "read_image"], requiredQualityCommands: [],
    executeTool: async () => { throw new Error("Unexpected tool"); }, quality: async () => { throw new Error("Unexpected quality"); },
    signal: new AbortController().signal, maxOutputTokens: undefined, ...overrides };
}

function chunk(response: ServerResponse, delta: unknown, finish: string | null = null) {
  response.write(`data: ${JSON.stringify({ id: "chat-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
function complete(response: ServerResponse, text: string, usage = true) {
  chunk(response, { role: "assistant", content: text });
  chunk(response, {}, "stop");
  if (usage) response.write(`data: ${JSON.stringify({ id: "chat-fixture", choices: [], usage: { prompt_tokens: 37, completion_tokens: 11, total_tokens: 48 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function endpoint(reply: (body: Record<string, unknown>, response: ServerResponse, index: number) => void) {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, response) => {
    const buffers: Buffer[] = [];
    for await (const part of req) buffers.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(buffers).toString()) as Record<string, unknown>;
    bodies.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    reply(body, response, bodies.length - 1);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server missing port");
  const origin = `http://127.0.0.1:${address.port}`;
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== origin) return Promise.reject(new Error("Non-fixture network denied"));
    return realFetch(input, init);
  });
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const provider: RuntimeProviderConfig = { id: "conductor-fixture", name: "Fixture", baseUrl: `${origin}/v1`, modelId: "fixture-model",
    apiKey: "task-owned-fixture-key", apiStyle: "openai-completions", authKind: "api-key", supportsReasoning: false, supportedThinkingLevels: ["off"] };
  const results: ConductorWorkerResult[] = [];
  const bridge = createConductorProvider({ ownerSessionId: "owner-fixture", provider, thinkingLevel: "off", recordResult: async event => { results.push(event); } });
  return { bridge, provider, bodies, results };
}

describe("Conductor actual SubagentRun transport (local provider boundary only)", () => {
  it("returns complete structured output beyond the generic Task report limit and journals actual usage", async () => {
    const expected = { run_id: "CON-2026-9201", summary: "x".repeat(15000) };
    const fixture = await endpoint((_body, response) => complete(response, JSON.stringify(expected)));
    expect(await fixture.bridge.dispatch(request())).toEqual(expected);
    expect(fixture.bodies).toHaveLength(1);
    expect(fixture.results[0]).toMatchObject({ workerId: "worker-fixture", dispatchId: "dispatch-fixture", status: "completed", usage: { inputTokens: 37, outputTokens: 11 } });
    expect(JSON.stringify(fixture.bodies[0])).not.toContain("main agent receives");
  });

  it("sends precisely the reserved critic prompt without tools/history and enforces its output cap", async () => {
    const fixture = await endpoint((_body, response) => complete(response, '{"conclusion":"holds"}'));
    const output = await fixture.bridge.dispatch(request({ mode: "critic", stage: "devils-advocate", run: undefined,
      input: { prompt: "Exact captured independent critic prompt." }, maxOutputTokens: 1234 }));
    expect(output).toEqual({ value: { conclusion: "holds" }, inputTokens: 37, outputTokens: 11 });
    const body = fixture.bodies[0];
    expect(body?.messages).toEqual([{ role: "user", content: [{ type: "text", text: "Exact captured independent critic prompt." }] }]);
    expect(body?.tools).toBeUndefined();
    expect(body?.max_tokens ?? body?.max_completion_tokens).toBe(1234);
  });

  it("does not invent usage when the external provider omits it", async () => {
    const fixture = await endpoint((_body, response) => complete(response, '{"conclusion":"holds"}', false));
    expect(await fixture.bridge.dispatch(request({ mode: "critic", stage: "devils-advocate", run: undefined, input: { prompt: "No usage fixture." } })))
      .toEqual({ value: { conclusion: "holds" } });
    expect(fixture.results[0]?.usage).toBeUndefined();
  });

  it("runs a normalized file tool through the dispatcher callback and preserves the next final JSON", async () => {
    const fixture = await endpoint((_body, response, index) => {
      if (index === 0) {
        chunk(response, { role: "assistant", tool_calls: [{ index: 0, id: "read-fixture", type: "function", function: { name: "read", arguments: '{"file_path":"fixture.txt"}' } }] });
        chunk(response, {}, "tool_calls"); response.end("data: [DONE]\n\n");
      } else complete(response, '{"summary":"Observed fixture."}');
    });
    const executeTool = vi.fn(async () => ({ ok: true, content: "owned fixture bytes" }));
    expect(await fixture.bridge.dispatch(request({ executeTool }))).toEqual({ summary: "Observed fixture." });
    expect(executeTool).toHaveBeenCalledWith("read", { path: "fixture.txt", file_path: "fixture.txt" });
    expect(fixture.bodies).toHaveLength(2);
    expect(JSON.stringify(fixture.bodies[1]?.messages)).toContain("owned fixture bytes");
    expect(fixture.results[0]?.toolCalls).toBe(1);
    expect(JSON.stringify(fixture.bodies[0]?.tools)).not.toMatch(/Bash|Task|read_image|mcp_|asktool/);
  });

  it("rejects model prose rather than treating it as a gate or falling back", async () => {
    const fixture = await endpoint((_body, response) => complete(response, "Gate A pass. All done."));
    await expect(fixture.bridge.dispatch(request())).rejects.toThrow("CONDUCTOR_WORKER_OUTPUT_INVALID_JSON");
    expect(fixture.bodies).toHaveLength(1);
  });

  it("aborts an active provider stream and does not record a completed worker", async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const fixture = await endpoint((_body, response) => { chunk(response, { role: "assistant", content: "{" }); entered(); });
    const controller = new AbortController();
    const pending = fixture.bridge.dispatch(request({ signal: controller.signal }));
    const outcome = expect(pending).rejects.toThrow();
    await started;
    controller.abort(new Error("Fixture stop"));
    await outcome;
    expect(fixture.results).toHaveLength(0);
  });

  it("does not return output before its host journal acknowledgement", async () => {
    const fixture = await endpoint((_body, response) => complete(response, '{"summary":"fixture"}'));
    const bridge = createConductorProvider({ ownerSessionId: "owner-fixture", provider: fixture.provider, thinkingLevel: "off",
      recordResult: async () => { throw new Error("Fixture journal unavailable"); } });
    await expect(bridge.dispatch(request())).rejects.toThrow("Fixture journal unavailable");
  });
});

describe("Conductor narrowed tool vocabulary", () => {
  it("rejects conflicting paths, undeclared aliases, rename and register indirection", () => {
    expect(() => conductorToolArguments("write", { path: "a", file_path: "b", content: "x" })).toThrow("AMBIGUOUS");
    expect(() => conductorToolArguments("write", { filename: "b", path: "a", content: "x" })).toThrow("ARGUMENTS_INVALID");
    for (const ops of ["MV ../outside", "CUT 1.=1\rMV ../outside", "PUT <1 @unvalidated"]) {
      expect(() => conductorToolArguments("edit", { path: "a", tag: "1234", ops })).toThrow("DENIED");
    }
    expect(() => conductorToolArguments("bash", { command: "x" })).toThrow("DENIED");
    expect(conductorToolArguments("glob", { query: "*.ts" })).toEqual({ pattern: "*.ts", path: ".", file_path: "." });
  });

  it("does not offer future-stage writes or critic tools", () => {
    expect(conductorTools(request()).map(tool => tool.name)).toEqual(["read", "grep", "glob"]);
    expect(conductorTools(request({ mode: "critic", tools: ["write"] }))).toEqual([]);
  });
});
