import { dialog, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { IPC } from "@pi-desktop/shared";
import type { IpcRegistrar } from "./types";
import type { PetsService } from "../pets/service";

import { assertPetSender } from "../pets/sender-guard";

export function registerPetsIpc({ registrar, pets, getMainWindow }: {
  registrar: IpcRegistrar; pets: PetsService; getMainWindow: () => BrowserWindow | null;
}) {
  const main = (event: IpcMainInvokeEvent) => assertPetSender(event, getMainWindow());
  const mini = (event: IpcMainInvokeEvent) => assertPetSender(event, pets.miniWindow());
  const read = (event: IpcMainInvokeEvent) => {
    if (event.sender.id === getMainWindow()?.webContents.id) main(event);
    else mini(event);
  };
  const { handleWithEvent: handle } = registrar;
  handle(IPC.invoke.petsList, async (event) => { read(event); return pets.list(); });
  handle(IPC.invoke.petsImage, async (event, id: unknown) => { read(event); return pets.importer.image(id); });
  handle(IPC.invoke.petsPreferences, async (event, patch: unknown) => { main(event); return pets.preferences(patch); });
  handle(IPC.invoke.petsPreviewImport, async (event) => {
    main(event);
    pets.importer.clear();
    const window = getMainWindow()!;
    const selected = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Pet manifest (pet.json)", extensions: ["json"] }] });
    main(event);
    if (selected.canceled || !selected.filePaths[0]) return null;
    return pets.importer.preview(selected.filePaths[0], event.sender.id);
  });
  handle(IPC.invoke.petsConfirmImport, async (event, token: unknown) => { main(event); return pets.confirm(token, event.sender.id); });
  handle(IPC.invoke.miniGetState, async (event) => { read(event); return pets.snapshot(); });
  handle(IPC.invoke.miniSetVisible, async (event, visible: unknown) => {
    read(event);
    if (typeof visible !== "boolean") throw new Error("PET_INVALID_PREFERENCES");
    if (visible) main(event);
    return pets.preferences({ miniVisible: visible });
  });
  handle(IPC.invoke.miniPublish, async (event, input: unknown) => { main(event); return pets.publish(input); });
  handle(IPC.invoke.miniAction, async (event, input: unknown) => { read(event); return pets.action(input); });
  handle(IPC.invoke.miniStartCapture, async (event) => { mini(event); return pets.dictation.start(); });
  handle(IPC.invoke.miniCancelCapture, async (event) => { mini(event); pets.dictation.invalidate(); });
  handle(IPC.invoke.miniTranscribe, async (event, input: unknown) => { mini(event); return pets.dictation.transcribe(input); });
  handle(IPC.invoke.miniOpenDraft, async (event, input: unknown) => { mini(event); return pets.openDraft(input); });
}
