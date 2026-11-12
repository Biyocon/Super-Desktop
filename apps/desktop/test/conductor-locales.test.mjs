import assert from "node:assert/strict";
import test from "node:test";
import { catalogs, flattenCatalog, supportedLocales } from "@pi-desktop/i18n";
const roles = ["conductor", "detective", "strategist", "devils-advocate", "headsman", "auditor", "integrator", "arbiter"];
test("Conductor has complete nonempty catalogs and stable contractual titles in all nine locales", () => {
  const english = flattenCatalog(catalogs.en.conductor);
  assert.ok(Object.keys(english).length > 110);
  for (const { id } of supportedLocales) {
    const catalog = flattenCatalog(catalogs[id].conductor);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(english).sort(), id);
    for (const [key, value] of Object.entries(catalog)) {
      assert.ok(typeof value === "string" && value.trim(), `${id}:${key}`);
      assert.deepEqual(value.match(/\{\{[^}]+\}\}/g) ?? [], english[key].match(/\{\{[^}]+\}\}/g) ?? [], `${id}:${key}`);
    }
    for (const role of roles) assert.equal(catalog[`roles.${role}`], english[`roles.${role}`], `${id}:${role}`);
    assert.match(catalog["roles.ralph"], /Ralph/); assert.match(catalog["roles.ralph"], /Headsman/);
    if (id !== "en") for (const key of ["open", "analysis", "permissionsHint", "consentHint", "statuses.rework", "transitions.validate-resume"]) assert.notEqual(catalog[key], english[key], `${id}:${key} must not fall back to English`);
  }
});
