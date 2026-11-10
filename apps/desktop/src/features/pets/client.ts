import { IPC, type PetLibrary, type PetPreferences, type PetImportPreview, type MiniSnapshot, type MiniActivity, type MiniAction, type MiniDraft } from "@pi-desktop/shared";
import type {} from "../../lib/api";

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.piDesktop) throw new Error("PRELOAD_UNAVAILABLE");
  const result = await window.piDesktop.invoke<T>(channel, ...args);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
const on = <T>(channel: string, listener: (value: T) => void) =>
  window.piDesktop?.on(channel, (value) => listener(value as T)) ?? (() => undefined);

export const petsClient = {
  list: () => invoke<PetLibrary>(IPC.invoke.petsList),
  image: (id: string) => invoke<string>(IPC.invoke.petsImage, id),
  preferences: (patch: Partial<PetPreferences>) => invoke<PetLibrary>(IPC.invoke.petsPreferences, patch),
  previewImport: () => invoke<PetImportPreview | null>(IPC.invoke.petsPreviewImport),
  confirmImport: (token: string) => invoke<PetLibrary>(IPC.invoke.petsConfirmImport, token),
  snapshot: () => invoke<MiniSnapshot>(IPC.invoke.miniGetState),
  setVisible: (visible: boolean) => invoke<PetLibrary>(IPC.invoke.miniSetVisible, visible),
  publish: (activity: MiniActivity) => invoke<void>(IPC.invoke.miniPublish, activity),
  action: (action: MiniAction) => invoke<void>(IPC.invoke.miniAction, action),
  startCapture: () => invoke<{ token: string; sessionId: string }>(IPC.invoke.miniStartCapture),
  cancelCapture: () => invoke<void>(IPC.invoke.miniCancelCapture),
  transcribe: (token: string, bytes: Uint8Array, mimeType: string) => invoke<MiniDraft>(IPC.invoke.miniTranscribe, { token, bytes, mimeType }),
  openDraft: (draft: MiniDraft) => invoke<void>(IPC.invoke.miniOpenDraft, draft),
  onChanged: (listener: (library: PetLibrary) => void) => on(IPC.event.petsChanged, listener),
  onState: (listener: (snapshot: MiniSnapshot) => void) => on(IPC.event.miniState, listener),
  onAction: (listener: (action: MiniAction | { draft: MiniDraft }) => void) => on(IPC.event.miniActionRequested, listener),
};
