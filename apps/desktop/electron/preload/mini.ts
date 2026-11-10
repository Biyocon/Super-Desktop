import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@pi-desktop/shared/protocol";

const invokes = new Set<string>([
  IPC.invoke.petsList, IPC.invoke.petsImage, IPC.invoke.miniGetState,
  IPC.invoke.miniSetVisible, IPC.invoke.miniAction, IPC.invoke.miniStartCapture,
  IPC.invoke.miniCancelCapture, IPC.invoke.miniTranscribe, IPC.invoke.miniOpenDraft,
]);
const events = new Set<string>([IPC.event.miniState, IPC.event.petsChanged]);
contextBridge.exposeInMainWorld("piDesktop", {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!invokes.has(channel)) return Promise.reject(new Error("MINI_CHANNEL_DENIED"));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    if (!events.has(channel)) throw new Error("MINI_CHANNEL_DENIED");
    const wrapped = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => listener(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  platform: process.platform,
  locale: process.argv.find((value) => value.startsWith("--pi-desktop-locale="))?.split("=")[1],
});
