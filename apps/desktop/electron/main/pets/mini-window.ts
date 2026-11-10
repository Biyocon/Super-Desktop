import { app, BrowserWindow, screen, session, type Rectangle } from "electron";
import { join } from "node:path";
import { IPC, type PetPreferences } from "@pi-desktop/shared";

export function clampMiniBounds(position: PetPreferences["position"], scale: number): Rectangle {
  const display = position ? screen.getDisplayNearestPoint(position) : screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = Math.min(area.width, Math.round(340 * scale));
  const height = Math.min(area.height, Math.round(500 * scale));
  return { width, height,
    x: Math.round(Math.max(area.x, Math.min(position?.x ?? area.x + area.width - width - 24, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(position?.y ?? area.y + area.height - height - 24, area.y + area.height - height))),
  };
}

/** Single native window; owns all listeners, native permissions and move debounce. */
export function createMiniWindow(options: {
  savePosition: (position: { x: number; y: number }) => Promise<void>;
  hide: () => Promise<unknown>;
  canCapture: () => boolean;
  invalidated: () => void;
  report: (error: unknown) => void;
}) {
  let window: BrowserWindow | null = null;
  let creating: Promise<BrowserWindow> | null = null;
  let disposed = false;
  let applying = false;
  let moveTimer: ReturnType<typeof setTimeout> | null = null;
  const clearMove = () => { if (moveTimer) clearTimeout(moveTimer); moveTimer = null; };
  const onDisplay = () => {
    if (!window || window.isDestroyed()) return;
    const bounds = window.getBounds();
    const scale = window.webContents.getZoomFactor();
    applying = true;
    window.setBounds(clampMiniBounds(bounds, scale));
    applying = false;
  };
  screen.on("display-removed", onDisplay);
  screen.on("display-metrics-changed", onDisplay);

  async function create(preferences: PetPreferences): Promise<BrowserWindow> {
    if (disposed) throw new Error("MINI_DISPOSED");
    if (window && !window.isDestroyed()) return window;
    if (creating) return creating;
    creating = (async () => {
      const isolated = session.fromPartition(`mini-${crypto.randomUUID()}`);
      const mini = new BrowserWindow({
        ...clampMiniBounds(preferences.position, preferences.scale),
        title: "Super-Desktop Mini", show: false, frame: false, transparent: true,
        backgroundColor: "#00000000", resizable: false, minimizable: false,
        maximizable: false, fullscreenable: false, skipTaskbar: true,
        alwaysOnTop: preferences.alwaysOnTop, autoHideMenuBar: true, hasShadow: false,
        webPreferences: { session: isolated, preload: join(__dirname, "../preload/mini.cjs"),
          sandbox: true, contextIsolation: true, nodeIntegration: false,
          additionalArguments: [`--pi-desktop-locale=${app.getLocale()}`] },
      });
      window = mini;
      mini.on("page-title-updated", (event) => event.preventDefault());
      isolated.setPermissionRequestHandler((contents, permission, callback, details) => {
        callback(contents.id === mini.webContents.id && permission === "media" &&
          details.isMainFrame && "mediaTypes" in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === "audio" && options.canCapture());
      });
      isolated.setPermissionCheckHandler((contents, permission, _origin, details) =>
        contents?.id === mini.webContents.id && permission === "media" && details.mediaType === "audio" && options.canCapture());
      mini.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      mini.webContents.on("will-navigate", (event) => event.preventDefault());
      mini.webContents.on("will-redirect", (event) => event.preventDefault());
      mini.webContents.on("did-start-loading", options.invalidated);
      mini.webContents.on("render-process-gone", options.invalidated);
      mini.on("hide", options.invalidated);
      mini.on("close", (event) => {
        if (disposed) return;
        event.preventDefault();
        void options.hide().catch(options.report);
      });
      mini.on("move", () => {
        if (applying || disposed || mini.isDestroyed()) return;
        clearMove();
        const { x, y } = mini.getBounds();
        moveTimer = setTimeout(() => {
          moveTimer = null;
          if (!disposed) void options.savePosition({ x, y }).catch(options.report);
        }, 250);
      });
      mini.on("closed", () => {
        clearMove();
        isolated.setPermissionRequestHandler(null);
        isolated.setPermissionCheckHandler(null);
        options.invalidated();
        if (window === mini) window = null;
      });
      try {
        if (process.env.ELECTRON_RENDERER_URL) {
          const url = new URL(process.env.ELECTRON_RENDERER_URL);
          url.searchParams.set("surface", "mini");
          await mini.loadURL(url.toString());
        } else {
          await mini.loadFile(join(__dirname, "../renderer/index.html"), { query: { surface: "mini" } });
        }
        if (disposed || mini.isDestroyed()) throw new Error("MINI_DISPOSED");
        return mini;
      } catch (error) {
        if (!mini.isDestroyed()) mini.destroy();
        throw error;
      }
    })();
    try { return await creating; } finally { creating = null; }
  }

  return {
    get: () => window && !window.isDestroyed() ? window : null,
    async apply(preferences: PetPreferences) {
      if (disposed) return;
      // A hidden preference must not create a hidden renderer at every app start.
      if (!preferences.miniVisible && !window && !creating) return;
      const mini = await create(preferences);
      if (disposed || mini.isDestroyed()) return;
      applying = true;
      try {
        mini.setAlwaysOnTop(preferences.alwaysOnTop);
        mini.webContents.setZoomFactor(preferences.scale);
        mini.setBounds(clampMiniBounds(preferences.position, preferences.scale), false);
        if (preferences.miniVisible) {
          if (!mini.isVisible()) mini.showInactive();
        } else mini.hide();
      } finally { applying = false; }
    },
    send(snapshot: unknown) {
      if (window && !window.isDestroyed()) window.webContents.send(IPC.event.miniState, snapshot);
    },
    focus() { if (window && !window.isDestroyed()) { window.show(); window.focus(); } },
    dispose() {
      disposed = true;
      clearMove();
      screen.removeListener("display-removed", onDisplay);
      screen.removeListener("display-metrics-changed", onDisplay);
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}
