import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { imageGenerationBindings, type AppSettings } from "@pi-desktop/shared";
import { DictationSettings } from "./DictationSettings";
import { Button, Field, Input, Textarea } from "../../components/ui";
import { SettingsCard } from "../settings/primitives";
import { useAppStore } from "../../stores/app-store";
import { PetSettings } from "./PetSettings";
import { launchPetCreation, PetCreationError } from "./creation-flow";

export function PetsPage({ saveSettings }: { saveSettings: (patch: Partial<AppSettings>) => Promise<void> }) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [task, setTask] = useState<string | null>(null);
  const settings = useAppStore((state) => state.settings);
  const workspace = useAppStore((state) => state.workspace?.path);
  const alive = useRef(true);
  const starting = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const bindings = imageGenerationBindings(settings?.imageGenerationModels, settings?.imageGeneration);
  const start = async () => {
    if (starting.current || !confirmed || !workspace || !bindings.length) return;
    starting.current = true; setBusy(true); setError(false);
    try {
      const id = await launchPetCreation(name, description);
      if (alive.current) setTask(id);
    } catch (failure) {
      if (alive.current) { setTask(failure instanceof PetCreationError ? failure.sessionId : null); setError(true); }
    } finally { starting.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="settings-stack">
    <PetSettings onCreate={() => { setCreating(true); setConfirmed(false); setError(false); }} />
    <DictationSettings saveSettings={saveSettings} />
    {creating && <SettingsCard title={t("pets.createTitle")}>
      <div className="pets-creation-form">
        <p>{t("pets.createExplanation")}</p>
        {!workspace && <p role="alert">{t("pets.workspaceRequired")}</p>}
        {!bindings.length && <p role="alert">{t("pets.imageModelRequired")}</p>}
        <p>{t("pets.creationModels", { agent: settings?.defaultModelId || t("pets.defaultAgent"), image: bindings.map((binding) => binding.modelId).join(", ") || t("pets.none") })}</p>
        <Field label={t("pets.name")}><Input maxLength={80} value={name} disabled={busy || !!task} onChange={(event) => { setName(event.target.value); setConfirmed(false); }} /></Field>
        <Field label={t("pets.description")}><Textarea maxLength={2_000} value={description} disabled={busy || !!task} onChange={(event) => { setDescription(event.target.value); setConfirmed(false); }} /></Field>
        {confirmed && <p role="note">{t("pets.costConfirmation")}</p>}
        {error && <p role="alert">{t("pets.creationFailed")}</p>}
        {task ? <Button onClick={() => { void useAppStore.getState().selectSession(task).catch(() => setError(true)); }}>{t("pets.openCreationTask")}</Button> :
          <Button disabled={busy || !name.trim() || !description.trim() || !workspace || !bindings.length} onClick={() => { if (confirmed) void start(); else setConfirmed(true); }}>{t(busy ? "pets.startingTask" : confirmed ? "pets.confirmCreate" : "pets.reviewCreation")}</Button>}
        <Button disabled={busy} onClick={() => { setCreating(false); setConfirmed(false); }}>{t("common.cancel")}</Button>
        <p>{t("pets.creationImportHint")}</p>
      </div>
    </SettingsCard>}
  </div>;
}
