import assert from "node:assert/strict";
import test from "node:test";

const locales = ["en", "zh-CN", "zh-TW", "de", "es", "tr", "fr", "ko", "pt-BR"];
function flatten(value, prefix = "", result = {}) {
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof entry === "string") result[path] = entry;
    else flatten(entry, path, result);
  }
  return result;
}
const catalogs = await Promise.all(locales.map(async (locale) => {
  const module = await import(new URL(`../../../packages/i18n/src/pets/${locale}.ts`, import.meta.url));
  return flatten(Object.values(module)[0]);
}));
const placeholders = (text) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort();
test("all nine pet locales have complete nonempty keys and matching interpolation", () => {
  for (const [index, catalog] of catalogs.entries()) {
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(catalogs[0]).sort(), locales[index]);
    for (const [key, text] of Object.entries(catalog)) {
      assert.ok(text.trim(), `${locales[index]} ${key}`);
      assert.deepEqual(placeholders(text), placeholders(catalogs[0][key]), `${locales[index]} ${key}`);
    }
  }
});
