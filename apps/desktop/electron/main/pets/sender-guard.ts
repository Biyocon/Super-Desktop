import type { BrowserWindow, IpcMainInvokeEvent } from "electron";

export function assertPetSender(event: IpcMainInvokeEvent, window: BrowserWindow | null): void {
  if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id ||
    !event.senderFrame || event.senderFrame !== window.webContents.mainFrame) {
    throw Object.assign(new Error("PERMISSION_DENIED"), { errorCode: "PERMISSION_DENIED" });
  }
}
