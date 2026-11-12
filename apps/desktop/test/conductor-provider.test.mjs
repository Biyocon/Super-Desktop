import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { OAUTH_AUTH_KIND, trustedExtensionAgentProviderId } from "@pi-desktop/shared";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");
function fixture(authKind = "api-key") {
  const calls = [];
  const provider = { id: "fixture-provider", name: "Owned fixture", authKind, baseUrl: "http://127.0.0.1:1/v1", apiStyle: "openai-chat",
    models: [{ id: "fixture-model", thinkingLevels: ["off"] }] };
  const forbidden = () => assert.fail("Conductor provider resolution must not load shell, skills, plugins, instructions or generic Tasks");
  const runtime = createSessionLaunchRuntime({ runtimeState: { host: { call: async (method, input) => {
    calls.push([method, input]);
    if (method === "providers.list") return { providers: [provider] };
    if (method === "providers.getSecret") return { value: "owned-fixture-key" };
    forbidden();
  } } }, logger: { app: forbidden }, userMcp: { setRecords: forbidden, toolsForProject: forbidden },
  plugins: { listLoaded: forbidden, getSkills: forbidden, getTools: forbidden, getAgentExtensions: forbidden }, sessionProjects: new Map(),
  dataDir: "unused-owned-fixture", vendorOAuth: { bindingFor: async (id, model) => { calls.push(["fixture.oauth.binding", { id, model }]); return { baseUrl: provider.baseUrl, apiStyle: provider.apiStyle }; } },
  modelsDevCatalog: { ensureLoaded: async () => {}, findModel: () => undefined }, getWorkspacePath: forbidden,
  pluginActiveInProject: forbidden, bindingForModel: (row, id) => row.models.find(model => model.id === id),
  effectiveSubagentModelConfig: forbidden, normalizeThinkingLevel: () => "off" });
  return { calls, provider, resolve: (session = {}) => runtime.resolveRuntimeProvider({ providerId: provider.id, modelId: "fixture-model", thinkingLevel: "off", ...session }, {}, {}, false) };
}
test("Conductor resolves only the owner model binding without generic launch catalogs", async () => {
  const f = fixture(); const result = await f.resolve();
  assert.equal(result.runtimeProvider.id, f.provider.id);
  assert.equal(result.runtimeProvider.apiKey, "owned-fixture-key");
  assert.equal(result.runtimeProvider.modelId, "fixture-model");
  assert.equal(result.thinkingLevel, "off");
  assert.deepEqual(f.calls.map(([method]) => method), ["providers.list", "providers.getSecret"]);
  for (const key of ["commandShell", "subagents", "pluginTools", "projectInstructions", "customSystemPrompt"]) assert.ok(!(key in result));
});
test("Conductor refuses missing selected provider instead of silently falling back", async () => {
  const f = fixture(); await assert.rejects(f.resolve({ providerId: "missing-owner-selection" }), /Selected Conductor provider is unavailable/);
  assert.deepEqual(f.calls.map(([method]) => method), ["providers.list"]);
});
test("Conductor refuses plugin agent identity before credential or extension loading", async () => {
  const f = fixture();
  await assert.rejects(f.resolve({ providerId: trustedExtensionAgentProviderId("fixture/plugin") }), /requires a direct model provider/);
  assert.deepEqual(f.calls.map(([method]) => method), ["providers.list"]);
});
test("OAuth keeps request-time auth separate and never reads or embeds API secrets", async () => {
  const f = fixture(OAUTH_AUTH_KIND); const result = await f.resolve();
  assert.equal(result.runtimeProvider.apiKey, ""); assert.equal(result.runtimeProvider.authKind, OAUTH_AUTH_KIND);
  assert.equal(result.runtimeProvider.resolveAuth, undefined);
  assert.deepEqual(f.calls.map(([method]) => method), ["providers.list", "fixture.oauth.binding"]);
});
