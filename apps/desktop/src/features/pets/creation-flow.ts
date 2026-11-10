import { imageGenerationBindings } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { buildPetCreationPrompt } from "./creation-task";

export class PetCreationError extends Error {
  constructor(public readonly sessionId: string | null) { super("PET_CREATION_START_FAILED"); }
}
/** Called only by the confirmation control, never by mounting the gallery. */
export async function launchPetCreation(name: string, description: string): Promise<string> {
  const initial = useAppStore.getState();
  const settings = initial.settings;
  const projectPath = initial.workspace?.path;
  if (!settings || !projectPath || !imageGenerationBindings(settings.imageGenerationModels, settings.imageGeneration).length) throw new PetCreationError(null);
  const prompt = buildPetCreationPrompt({ name, description, jobId: crypto.randomUUID() });
  let sessionId: string | null = null;
  try {
    const result = await api.createSession({ title: name.trim(), projectPath, mode: "agent", permissionMode: "ask",
      providerId: settings.defaultProviderId, modelId: settings.defaultModelId });
    sessionId = result.session.id;
    await useAppStore.getState().refreshSessions();
    const latest = useAppStore.getState();
    // Never navigate over a selection made while the host was creating the task.
    if (latest.activeSessionId === initial.activeSessionId && latest.page === initial.page && latest.workspace?.path === projectPath) await latest.selectSession(sessionId);
    const accepted = await useAppStore.getState().sendPrompt(prompt, undefined, sessionId);
    if (!accepted) throw new Error("PET_TASK_NOT_ACCEPTED");
    return sessionId;
  } catch {
    throw new PetCreationError(sessionId);
  }
}
