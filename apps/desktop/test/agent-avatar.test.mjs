import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as shared from "@pi-desktop/shared";

const require = createRequire(new URL("../package.json", import.meta.url));
const runtimeRequire = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url));
const { build } = runtimeRequire("esbuild");
const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../src/components/AgentAvatar.tsx", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["react", "react/*", "@pi-desktop/*"],
  jsx: "automatic",
  loader: { ".png": "dataurl" },
  logLevel: "silent",
});
const module = { exports: {} };
const external = (id) => id === "@pi-desktop/shared" ? shared : require(id);
new Function("require", "module", "exports", compiled.outputFiles[0].text)(external, module, module.exports);
const { AgentAvatar, CONDUCTOR_ROLES, ConductorAvatar, resolveRoleId, roleAvatarUrl } = module.exports;

function render(agentName, size = 28) {
  return renderToStaticMarkup(createElement(AgentAvatar, { agentName, size }));
}

function assertGlyph(name) {
  const html = render(name);
  assert.equal(resolveRoleId(name), undefined, `${name} must not imply a Conductor role`);
  assert.match(html, /<svg\b/);
  assert.doesNotMatch(html, /<img\b/);
}

test("generic builtin names never alias to specialist roles or portraits", () => {
  for (const name of [
    "explorer", "code-reviewer", "test-runner", "fixer",
    "Explorer", "Code Reviewer", "Test_Runner.md", "FIXER.md",
    "/fixtures/Code_Reviewer.md", "conductor-explorer", "conductor-code-reviewer",
    "conductor-test-runner", "conductor-fixer",
  ]) assertGlyph(name);
});

test("unknown and missing agent names retain the generic glyph", () => {
  for (const name of [undefined, "", "project-reviewer", "custom Detective", "constructor", "toString"])
    assertGlyph(name);
});

test("the authoritative role catalog and direct asset accessor remain available", () => {
  assert.deepEqual(CONDUCTOR_ROLES, [
    "conductor", "detective", "strategist", "devils-advocate",
    "headsman", "auditor", "integrator", "arbiter",
  ]);
  const urls = CONDUCTOR_ROLES.map(roleAvatarUrl);
  assert.equal(new Set(urls).size, CONDUCTOR_ROLES.length);
  for (const role of CONDUCTOR_ROLES) {
    assert.equal(typeof roleAvatarUrl(role), "string");
    assert.ok(roleAvatarUrl(role).length > 0);
    assert.equal(resolveRoleId(role), role);
    const html = render(role, 20);
    assert.ok(html.includes(`src="${roleAvatarUrl(role)}"`));
    assert.match(html, /<img\b[^>]*alt=""[^>]*aria-hidden="true"[^>]*width="20"[^>]*height="20"[^>]*draggable="false"/);
    assert.doesNotMatch(html, /<svg\b/);
  }
});

test("explicit role-name decoration normalizes names without changing the agent's identity", () => {
  for (const [name, role] of [
    ["Detective", "detective"],
    ["/fixtures/Detective.md", "detective"],
    ["conductor-detective", "detective"],
    ["Devil's Advocate", "devils-advocate"],
    ["Devil’s Advocate", "devils-advocate"],
  ]) {
    assert.equal(resolveRoleId(name), role);
    assert.ok(render(name).includes(`src="${roleAvatarUrl(role)}"`));
  }
});

test("an explicit Conductor portrait stays separate from a generic parent avatar", () => {
  assertGlyph(undefined);
  const html = renderToStaticMarkup(createElement(ConductorAvatar, { size: 28 }));
  assert.ok(html.includes(`src="${roleAvatarUrl("conductor")}"`));
  assert.match(html, /<img\b/);
});
