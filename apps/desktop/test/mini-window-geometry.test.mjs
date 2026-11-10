import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as shared from "@pi-desktop/shared";

const require = createRequire(import.meta.url);
const runtimeRequire = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url));
const { build } = runtimeRequire("esbuild");
let displays = [];
// Only Electron's external screen boundary is substituted; execute the real clamp.
const screen = {
  getPrimaryDisplay: () => displays[0],
  getDisplayNearestPoint: point => displays.reduce((best, display) => {
    const distance = ({ workArea: a }) => Math.hypot(Math.max(a.x - point.x, 0, point.x - a.x - a.width), Math.max(a.y - point.y, 0, point.y - a.y - a.height));
    return distance(display) < distance(best) ? display : best;
  }),
};
const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../electron/main/pets/mini-window.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "cjs", external: ["electron", "@pi-desktop/*"], logLevel: "silent",
});
const module = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(id => id === "electron" ? { screen } : id === "@pi-desktop/shared" ? shared : require(id), module, module.exports);
const { clampMiniBounds } = module.exports;
const display = (x, y, width, height) => ({ workArea: { x, y, width, height } });

test("new Mini fits the primary work area at supported pet zooms", () => {
  displays = [display(0, 0, 1920, 1040)];
  assert.deepEqual(clampMiniBounds(undefined, 1), { x: 1556, y: 516, width: 340, height: 500 });
  assert.deepEqual(clampMiniBounds(undefined, 1.5), { x: 1386, y: 266, width: 510, height: 750 });
});

test("changed physical-display DIP metrics clamp saved positions without oversized bounds", () => {
  displays = [display(0, 0, 2560, 1392)];
  const at150 = clampMiniBounds({ x: 2047, y: 901 }, 1);
  assert.deepEqual(at150, { x: 2047, y: 892, width: 340, height: 500 });
  displays = [display(0, 0, 2195, 1187)];
  assert.deepEqual(clampMiniBounds(at150, 1), { x: 1855, y: 687, width: 340, height: 500 });
});

test("negative-origin and removed-display geometry fixtures keep Mini in an available work area", () => {
  displays = [display(0, 0, 1920, 1040), display(-1280, 0, 1280, 984)];
  const onLeft = clampMiniBounds({ x: -1000, y: 900 }, 1);
  assert.deepEqual(onLeft, { x: -1000, y: 484, width: 340, height: 500 });
  displays = [displays[0]];
  assert.deepEqual(clampMiniBounds(onLeft, 1), { x: 0, y: 484, width: 340, height: 500 });
});

test("a small work area caps both dimensions and extreme saved coordinates", () => {
  displays = [display(10, 20, 200, 150)];
  assert.deepEqual(clampMiniBounds({ x: -100000, y: 100000 }, 1.5), { x: 10, y: 20, width: 200, height: 150 });
});
