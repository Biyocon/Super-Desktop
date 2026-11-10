import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const desktop = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const pkg = require("../package.json");
const windows = require("../electron-builder.windows.cjs");
const shared = await import("@pi-desktop/shared");

// Only external OS/update boundaries are replaced. The real controller and
// its URL/timeout helpers run, so an accidental feed or installer call fails.
function updaterFixture() {
  const calls = [];
  const autoUpdater = new Proxy({}, {
    get: (_target, method) => (...args) => { calls.push([method, ...args]); throw new Error(`unexpected updater call: ${String(method)}`); },
    set: () => { throw new Error("unexpected updater configuration"); },
  });
  const electron = { app: { isPackaged: true }, shell: { openExternal: async (url) => { calls.push(["openExternal", url]); } } };
  function load(path) {
    const source = readFileSync(path, "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const module = { exports: {} };
    const localRequire = (name) => {
      if (name === "@pi-desktop/shared") return shared;
      if (name === "electron") return electron;
      if (name === "electron-updater") return { autoUpdater };
      if (name.startsWith("./")) return load(join(dirname(path), `${name}.ts`));
      return require(name);
    };
    new Function("require", "module", "exports", code)(localRequire, module, module.exports);
    return module.exports;
  }
  return { ...load(join(desktop, "electron/main/updater.ts")), calls };
}

test("Windows installer identity is separate and other platform contracts survive", () => {
  assert.equal(windows.appId, "io.github.biyocon.super-desktop");
  assert.notEqual(windows.appId, pkg.build.appId);
  assert.equal(windows.extraMetadata.name, "super-desktop");
  assert.equal(windows.extraMetadata.superDesktopReleaseStage, "internal");
  assert.equal(windows.win.executableName, "Super-Desktop");
  assert.equal(windows.nsis.shortcutName, "Super-Desktop");
  assert.equal(windows.nsis.uninstallDisplayName, "Super-Desktop");
  assert.equal(windows.nsis.deleteAppDataOnUninstall, false);
  assert.equal(windows.nsis.artifactName, "Super-Desktop-Setup-${version}-${arch}.${ext}");
  assert.deepEqual(windows.publish, [{ provider: "github", owner: "Biyocon", repo: "Super-Desktop" }]);
  assert.deepEqual(windows.mac, pkg.build.mac);
  assert.deepEqual(windows.linux, pkg.build.linux);
  assert.equal(pkg.build.appId, "net.aiuo.pi-desktop");
});

test("internal Windows builds never check, download, install, or schedule updates", async () => {
  const fixture = updaterFixture();
  for (const distribution of ["installed", "zip"]) {
    const controller = new fixture.AppUpdaterController({ logger: { app() {} }, send() {}, currentVersion: "0.15.7-super.1", platform: "win32", isPackaged: true, distribution });
    assert.equal(controller.getState().mode, "disabled");
    assert.equal(controller.getState().currentVersion, "0.15.7-super.1");
    controller.startAutoCheck();
    await assert.rejects(controller.check({ manual: true }), /updates are disabled/);
    await assert.rejects(controller.download(), /not supported/);
    assert.throws(() => controller.install(), /no downloaded update/);
    assert.equal(controller.isInstallingUpdate(), false);
    assert.deepEqual(fixture.calls, []);
    if (process.platform === "win32") {
      assert.equal(controller.getState().releasesUrl, "https://github.com/Biyocon/Super-Desktop/releases");
      await controller.openReleases();
      assert.deepEqual(fixture.calls.pop(), ["openExternal", "https://github.com/Biyocon/Super-Desktop/releases"]);
    }
    controller.dispose();
  }
});

test("legacy non-Windows update policy is unchanged", () => {
  const { resolveUpdateMode } = updaterFixture();
  assert.equal(resolveUpdateMode("darwin", true, {}, undefined, "0.15.7-super.1"), "in-app");
  assert.equal(resolveUpdateMode("linux", true, { APPIMAGE: "/test/app" }, undefined, "0.15.7-super.1"), "in-app");
  assert.equal(resolveUpdateMode("linux", true, {}, undefined, "0.15.7-super.1"), "manual");
  assert.equal(resolveUpdateMode("win32", true, {}, "installed", "0.15.7"), "in-app");
  assert.equal(resolveUpdateMode("win32", true, {}, "zip", "0.15.7"), "manual");
  assert.equal(resolveUpdateMode("darwin", false, {}), "disabled");
});
