import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { activeUserSubagentHandles, userSubagentAtLimit } = await import("../src/components/settings/subagent-user-budget.ts");
const row = (name, enabled = true, id = name) => ({ id, name, enabled });

test("the sixteenth user handle fits; a seventeenth does not; disabling frees a slot", () => {
  const rows = Array.from({ length: 15 }, (_, i) => row(`user-${i}`));
  assert.equal(activeUserSubagentHandles(rows).size, 15);
  assert.equal(userSubagentAtLimit(rows, row("sixteen", false)), false);
  rows.push(row("sixteen"));
  assert.equal(userSubagentAtLimit(rows, row("seventeen", false)), true);
  rows[0].enabled = false;
  assert.equal(userSubagentAtLimit(rows, row("seventeen", false)), false);
});

test("registry/library duplicates use one slot and reach the host conflict check", () => {
  const rows = Array.from({ length: 16 }, (_, i) => row(`user-${i}`));
  rows.push(row("user-0", true, "customagents:user-0"));
  assert.equal(activeUserSubagentHandles(rows).size, 16);
  assert.equal(userSubagentAtLimit(rows, row("user-0", false, "other-source")), false);
  assert.equal(userSubagentAtLimit(rows, row("new", false)), true);
  assert.equal(activeUserSubagentHandles([row("", true, "legacy")]).has("legacy"), true);
});
