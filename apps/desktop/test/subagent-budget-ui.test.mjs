import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { act, createElement as h } from "react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import * as reactI18next from "react-i18next";
import * as shared from "@pi-desktop/shared";
import * as catalog from "@pi-desktop/i18n";
import { installBrowser, descendants } from "./helpers/react-dom-host.mjs";
const require = createRequire(new URL("../package.json", import.meta.url));
const runtimeRequire = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url));
const { build } = runtimeRequire("esbuild");
const compiled = await build({
  stdin: { contents: 'export { AgentSubagentsPage } from "./components/settings/AgentSubagentsPage"; export { useAppStore } from "./stores/app-store";', resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "tsx" },
  bundle: true, write: false, platform: "node", format: "cjs", packages: "external", jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent",
});
installBrowser();
const { createRoot } = require("react-dom/client");
const record = (name, enabled = true, source = "registry", id = name) => ({ id, name, enabled, source, description: id, tools: ["Read"], path: `fixture/${id}.md`, scope: { mode: "all" } });
function deferred() { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; }
async function fixture(t, count = 15, extra = []) {
  const env = installBrowser();
  let rows = [...Array.from({ length: count }, (_, i) => record(`user-${i}`)), record("sixteen", false), record("seventeen", false), ...extra];
  let builtins = Array.from({ length: 5 }, (_, i) => ({ name: `builtin-${i}`, source: "builtin", description: "Fixture builtin", tools: ["Read"], enabled: true, prompt: "Read only" }));
  const calls = []; const listeners = new Map(); let pending;
  env.window.piDesktop = {
    invoke: async (channel, ...args) => {
      calls.push({ channel, args });
      if (channel === shared.IPC.invoke.subagentList) return { ok: true, data: { subagents: structuredClone(rows) } };
      if (channel === shared.IPC.invoke.subagentCatalog) return { ok: true, data: { builtins: structuredClone(builtins), subagents: [], diagnostics: [] } };
      if ([shared.IPC.invoke.subagentSetEnabled, shared.IPC.invoke.subagentSetBuiltinEnabled].includes(channel)) {
        if (pending) { const wait = pending; pending = null; const response = await wait.promise; if (!response.ok) return response; }
        const { id, enabled } = args[0];
        if (channel === shared.IPC.invoke.subagentSetEnabled) {
          const target = rows.find((r) => r.id === id);
          if (enabled && rows.some((r) => r.enabled && r.id !== id && r.name === target.name)) return { ok: false, error: { message: "SUBAGENT_CONFLICT" } };
          rows = rows.map((r) => r.id === id ? { ...r, enabled } : r);
        } else builtins = builtins.map((r) => r.name === id ? { ...r, enabled } : r);
        return { ok: true, data: {} };
      }
      throw new Error(`Unexpected IPC: ${channel}`);
    },
    on: (channel, listener) => { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); return () => set.delete(listener); },
  };
  const module = { exports: {} };
  const external = (id) => id === "@pi-desktop/shared" ? shared : id === "@pi-desktop/i18n" ? catalog : id === "react-i18next" ? reactI18next : require(id);
  new Function("require", "module", "exports", compiled.outputFiles[0].text)(external, module, module.exports);
  const { AgentSubagentsPage, useAppStore } = module.exports;
  const i18n = createInstance();
  const translation = {
    settings: { toggleCapability: "Toggle {{name}}" },
    extensions: { subagents: { activeCount: "Active {{current}} / {{max}}", activeLimit: "Limit {{max}}" } },
  };
  await i18n.init({ lng: "en", fallbackLng: false, resources: { en: { translation } }, react: { useSuspense: false } });
  const container = env.document.createElement("div"); env.document.body.appendChild(container); const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); });
  await act(async () => root.render(h(I18nextProvider, { i18n }, h(AgentSubagentsPage))));
  const switches = (name) => descendants(container).filter((e) => e.getAttribute?.("role") === "switch" && e.getAttribute("aria-label") === `Toggle ${name}`);
  return { container, calls, switches, rows: () => rows, builtins: () => builtins, toasts: () => useAppStore.getState().toasts,
    hold() { pending = deferred(); return pending; },
    async click(name, index = 0) { const button = switches(name)[index]; assert.ok(button, `Missing switch: ${name}`); await act(async () => button.click()); },
  };
}

test("Settings excludes five builtins, enables user 16, refuses 17 and reuses a released slot", async (t) => {
  const f = await fixture(t);
  assert.ok(f.container.textContent.includes("Active 15 / 16"));
  await f.click("sixteen");
  assert.equal(f.rows().find((r) => r.id === "sixteen").enabled, true);
  assert.ok(f.container.textContent.includes("Active 16 / 16"));
  const before = f.calls.filter((c) => c.channel === shared.IPC.invoke.subagentSetEnabled).length;
  await f.click("seventeen");
  assert.equal(f.rows().find((r) => r.id === "seventeen").enabled, false);
  assert.equal(f.calls.filter((c) => c.channel === shared.IPC.invoke.subagentSetEnabled).length, before);
  await f.click("user-0"); await f.click("seventeen");
  assert.equal(f.rows().find((r) => r.id === "seventeen").enabled, true);
  assert.ok(f.container.textContent.includes("Active 16 / 16"));
  await f.click("builtin-0"); await f.click("builtin-0");
  assert.equal(f.builtins()[0].enabled, true);
  assert.ok(f.container.textContent.includes("Active 16 / 16"));
});

test("host rejection rolls the actual optimistic user switch and counter back", async (t) => {
  const f = await fixture(t); const pending = f.hold();
  await f.click("sixteen");
  assert.equal(f.switches("sixteen")[0].getAttribute("aria-checked"), "true");
  assert.ok(f.container.textContent.includes("Active 16 / 16"));
  await act(async () => pending.resolve({ ok: false, error: { message: "fixture disk failure" } }));
  assert.equal(f.switches("sixteen")[0].getAttribute("aria-checked"), "false");
  assert.ok(f.container.textContent.includes("Active 15 / 16"));
  assert.ok(f.toasts().some((x) => x.message.includes("fixture disk failure")));
});

test("duplicate library handle consumes no extra slot and host conflict restores its switch", async (t) => {
  const f = await fixture(t, 16, [record("user-0", false, "customagents", "customagents:user-0")]);
  assert.ok(f.container.textContent.includes("Active 16 / 16"));
  await f.click("user-0", 1);
  assert.equal(f.switches("user-0")[1].getAttribute("aria-checked"), "false");
  assert.equal(f.switches("user-0")[0].getAttribute("aria-checked"), "true");
  assert.ok(f.toasts().some((x) => x.message.includes("SUBAGENT_CONFLICT")));
  assert.ok(f.container.textContent.includes("Active 16 / 16"));
});

test("builtin rejection rolls back independently of a full user budget", async (t) => {
  const f = await fixture(t, 16); const pending = f.hold();
  await f.click("builtin-0");
  assert.equal(f.switches("builtin-0")[0].getAttribute("aria-checked"), "false");
  await act(async () => pending.resolve({ ok: false, error: { message: "builtin state failed" } }));
  assert.equal(f.switches("builtin-0")[0].getAttribute("aria-checked"), "true");
  assert.ok(f.container.textContent.includes("Active 16 / 16"));
});
