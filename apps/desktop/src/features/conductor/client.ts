import { IPC, type ConductorChanged, type ConductorFault } from "@pi-desktop/shared";
import { api } from "../../lib/api";

export const conductorClient = {
  availability: api.conductorAvailability,
  catalog: api.conductorCatalog,
  list: api.conductorList,
  history: api.conductorHistory,
  start: api.conductorStart,
  resume: api.conductorResume,
  cancel: api.conductorCancel,
  cancelAdmission: api.conductorCancelAdmission,
  authorize: api.conductorAuthorize,
  onChanged(listener: (event: ConductorChanged) => void) {
    return listen(IPC.event.conductorChanged, listener);
  },
  onFault(listener: (event: ConductorFault) => void) {
    return listen(IPC.event.conductorFault, listener);
  },
};

function listen<T extends ConductorChanged>(channel: string, listener: (event: T) => void) {
  if (!window.piDesktop?.on) return () => undefined;
  return window.piDesktop.on(channel, (payload) => {
    if (!payload || typeof payload !== "object") return;
    const event = payload as T;
    if (typeof event.sessionId === "string" && typeof event.runId === "string") listener(event);
  });
}
export type ConductorClient = typeof conductorClient;
