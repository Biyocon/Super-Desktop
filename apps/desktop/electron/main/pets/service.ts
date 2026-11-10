import { app, globalShortcut, nativeTheme, type BrowserWindow, type WebContents } from "electron";
import { resolveLocale } from "@pi-desktop/i18n";
import { IPC, KEYBOARD_SHORTCUTS, keybindingToElectronAccelerator, resolveKeybinding, parseMiniActivity,
  type AppSettings, type MiniActivity, type MiniAction, type MiniSnapshot, type PetLibrary } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { SpeechService } from "../services/speech-service";
import type { Logger } from "../logger";
import { recordHostGlobalBinding } from "../bootstrap/launcher";
import { createPetImportService } from "./import-service";
import { createMiniWindow } from "./mini-window";
import { createMiniDictation } from "./dictation";

const IDLE: MiniActivity = { sessionId: null, title: "", status: "idle" };

export function createPetsService(options: {
  dataDir: string;
  getHost: () => HostProcess | null;
  getMainWindow: () => BrowserWindow | null;
  speech: SpeechService;
  logger: Pick<Logger, "app">;
}) {
  let library: PetLibrary | null = null;
  let settings: AppSettings | null = null;
  let activity = IDLE;
  let disposed = false;
  let initialize: Promise<void> | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  let accelerator: string | null = null;
  let shortcutError: string | null = null;
  let dictationAvailable = false;
  let captureGeneration = 0;
  let runtimeError: string | null = null;
  let owner: WebContents | null = null;
  const importer = createPetImportService(options.getHost);
  const host = () => {
    const value = options.getHost();
    if (!value || disposed) throw new Error("HOST_UNAVAILABLE");
    return value;
  };
  const report = (error: unknown) => {
    options.logger.app("diagnostics", "error", "Mini operation failed", { data: String(error) });
    runtimeError = "MINI_OPERATION_FAILED";
    broadcast();
  };
  const dictation = createMiniDictation({ ...options, session: () => activity.sessionId,
    visible: () => !disposed && !!library?.preferences.miniVisible && !!mini.get()?.isVisible() });
  const mini = createMiniWindow({
    savePosition: async (position) => { await preferences({ position }); },
    hide: () => preferences({ miniVisible: false }),
    canCapture: dictation.canCapture,
    invalidated: invalidateCapture,
    report,
  });
  function snapshotValue(): MiniSnapshot {
    if (!library) throw new Error("PETS_NOT_READY");
    return { ...library, activity, shortcutError, dictationAvailable, captureGeneration, runtimeError,
      visible: !!mini.get()?.isVisible(),
      language: resolveLocale(settings?.language === "auto" ? app.getLocale() : settings?.language ?? app.getLocale()),
      theme: settings?.theme === "light" ? "light" : settings?.theme === "dark" ? "dark" : nativeTheme.shouldUseDarkColors ? "dark" : "light" };
  }
  function broadcast(libraryChanged = false) {
    if (!library || disposed) return;
    const window = options.getMainWindow();
    if (libraryChanged && window && !window.isDestroyed()) window.webContents.send(IPC.event.petsChanged, library);
    mini.send(snapshotValue());
  }
  function invalidateCapture() {
    captureGeneration += 1;
    dictation.invalidate();
    broadcast();
  }
  function resetOwner() {
    activity = IDLE;
    importer.clear();
    invalidateCapture();
    broadcast();
  }
  function bindOwner() {
    const next = options.getMainWindow()?.webContents ?? null;
    if (owner === next) return;
    if (owner && !owner.isDestroyed()) {
      owner.removeListener("did-start-loading", resetOwner);
      owner.removeListener("render-process-gone", resetOwner);
      owner.removeListener("destroyed", resetOwner);
    }
    owner = next;
    owner?.on("did-start-loading", resetOwner);
    owner?.on("render-process-gone", resetOwner);
    owner?.on("destroyed", resetOwner);
  }
  function rebind() {
    const shortcut = KEYBOARD_SHORTCUTS.find((candidate) => candidate.id === "toggleMini");
    if (!shortcut) return;
    const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
    const binding = resolveKeybinding(shortcut, settings?.keybindings, platform);
    const next = keybindingToElectronAccelerator(binding, platform);
    if (next === accelerator && !shortcutError) return;
    if (accelerator) globalShortcut.unregister(accelerator);
    accelerator = null;
    recordHostGlobalBinding("toggleMini", null);
    shortcutError = null;
    if (!next) return;
    try {
      if (!globalShortcut.register(next, () => { void toggle().catch(report); })) throw new Error("MINI_SHORTCUT_UNAVAILABLE");
      accelerator = next;
      recordHostGlobalBinding("toggleMini", binding);
    } catch {
      shortcutError = "MINI_SHORTCUT_UNAVAILABLE";
    }
  }
  async function ready() {
    if (disposed) throw new Error("MINI_DISPOSED");
    bindOwner();
    if (library) return;
    if (!initialize) initialize = (async () => {
      const [loaded, configured, status] = await Promise.all([
        host().call<PetLibrary>("pets.list"), host().call<AppSettings>("settings.get"), options.speech.status(),
      ]);
      if (disposed) return;
      library = loaded;
      settings = configured;
      dictationAvailable = status.transcribe.available;
      rebind();
      await mini.apply(loaded.preferences);
      broadcast(true);
    })();
    try { await initialize; } finally { initialize = null; }
  }
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = writes.then(operation);
    writes = result.catch(() => undefined);
    return result;
  }
  async function apply(next: PetLibrary): Promise<PetLibrary> {
    if (disposed) throw new Error("MINI_DISPOSED");
    library = next;
    if (!next.preferences.miniVisible) invalidateCapture();
    await mini.apply(next.preferences);
    runtimeError = null;
    broadcast(true);
    return next;
  }
  async function preferences(patch: unknown) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("PET_INVALID_PREFERENCES");
    // Invalidate before the async save, not after a provider can return.
    if ((patch as Record<string, unknown>).miniVisible === false) invalidateCapture();
    return serialize(async () => {
      await ready();
      return apply(await host().call<PetLibrary>("pets.preferences", patch));
    });
  }
  async function toggle() {
    return serialize(async () => {
      await ready();
      const next = await host().call<PetLibrary>("pets.preferences", { miniVisible: !library!.preferences.miniVisible });
      await apply(next);
      if (next.preferences.miniVisible) mini.focus();
    });
  }
  const onTheme = () => broadcast();
  nativeTheme.on("updated", onTheme);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    importer.clear();
    dictation.invalidate();
    mini.dispose();
    if (accelerator) globalShortcut.unregister(accelerator);
    recordHostGlobalBinding("toggleMini", null);
    nativeTheme.removeListener("updated", onTheme);
    if (owner && !owner.isDestroyed()) {
      owner.removeListener("did-start-loading", resetOwner);
      owner.removeListener("render-process-gone", resetOwner);
      owner.removeListener("destroyed", resetOwner);
    }
    owner = null;
    app.removeListener("before-quit", dispose);
  };
  app.once("before-quit", dispose);

  return {
    miniWindow: mini.get,
    importer,
    dictation,
    dispose,
    async list() { await ready(); return library!; },
    async snapshot() { await ready(); return snapshotValue(); },
    preferences,
    async confirm(token: unknown, ownerId: number) {
      return serialize(async () => { await ready(); return apply(await importer.confirm(token, ownerId)); });
    },
    async refreshSettings() {
      await ready();
      const [next, status] = await Promise.all([host().call<AppSettings>("settings.get"), options.speech.status()]);
      if (disposed) return;
      settings = next;
      dictationAvailable = status.transcribe.available;
      if (!dictationAvailable) invalidateCapture();
      rebind();
      broadcast(true);
    },
    async publish(input: unknown) {
      await ready();
      const next = parseMiniActivity(input);
      if (activity.sessionId !== next.sessionId) invalidateCapture();
      activity = next;
      broadcast();
    },
    async action(input: unknown) {
      await ready();
      if (!["newTask", "settings", "focus", "dictate"].includes(String(input))) throw new Error("MINI_INVALID_ACTION");
      const window = options.getMainWindow();
      if (!window || window.isDestroyed()) throw new Error("MAIN_WINDOW_UNAVAILABLE");
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
      if (input !== "focus") window.webContents.send(IPC.event.miniActionRequested, input as MiniAction);
    },
    async openDraft(input: unknown) {
      const value = dictation.takeDraft(input);
      const window = options.getMainWindow();
      if (!window || window.isDestroyed()) throw new Error("MAIN_WINDOW_UNAVAILABLE");
      if (window.isMinimized()) window.restore();
      window.show(); window.focus();
      window.webContents.send(IPC.event.miniActionRequested, { draft: value });
    },
  };
}
export type PetsService = ReturnType<typeof createPetsService>;
