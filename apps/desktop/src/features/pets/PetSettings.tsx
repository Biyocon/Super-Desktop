import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PetImportPreview, PetPreferences, PetRecord } from "@pi-desktop/shared";
import { Button, Input, SettingsToggle } from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { SettingsCard, SettingsRow } from "../settings/primitives";
import { petsClient } from "./client";
import { PetSprite } from "./PetSprite";
import { usePetImage, usePetLibrary } from "./pet-store";
import "./pets.css";

type Operation = (isCurrent: () => boolean) => Promise<void>;
type OperationError = { key: "pets.saveError" | "pets.importError"; retry: Operation };

function PetChoice({ pet, selected, disabled, onSelect }: {
  pet: PetRecord;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const image = usePetImage(pet.id);
  return <Button type="button" className="pets-choice" aria-pressed={selected} disabled={disabled} onClick={onSelect}>
    <span className="pets-choice-preview" aria-hidden="true">
      {image ? <PetSprite pet={pet} dataUrl={image} decorative /> :
        <span className="pets-hint">{t("pets.previewUnavailable")}</span>}
    </span>
    <span className="pets-choice-name">{pet.displayName}</span>
    {pet.description && <span className="pets-choice-description">{pet.description}</span>}
    <span className="pets-choice-status">{selected ? t("pets.selected") : t("pets.select")}</span>
  </Button>;
}

export function PetSettings({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  const { library, error: loadError, refresh } = usePetLibrary();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<PetImportPreview | null>(null);
  const [operationError, setOperationError] = useState<OperationError | null>(null);
  const [shortcutError, setShortcutError] = useState(false);
  const [snapshotError, setSnapshotError] = useState(false);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const alive = useRef(false);
  const locked = useRef(false);
  const lifetime = useRef(0);
  const importButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const restoreImportFocus = useRef(false);

  useEffect(() => {
    alive.current = true;
    ++lifetime.current;
    return () => { alive.current = false; ++lifetime.current; };
  }, []);

  useEffect(() => {
    if (!library) return;
    let cancelled = false;
    setSnapshotError(false);
    void petsClient.snapshot().then((snapshot) => {
      if (!cancelled) setShortcutError(!!snapshot.shortcutError);
    }).catch(() => {
      if (!cancelled) setSnapshotError(true);
    });
    return () => { cancelled = true; };
  }, [library, snapshotRevision]);

  useEffect(() => {
    if (busy) return;
    if (preview) {
      restoreImportFocus.current = true;
      cancelButton.current?.focus();
    } else if (restoreImportFocus.current) {
      restoreImportFocus.current = false;
      importButton.current?.focus();
    }
  }, [preview, busy]);

  const run = async (work: Operation, key: OperationError["key"]) => {
    if (locked.current) return;
    const currentLifetime = lifetime.current;
    const isCurrent = () => alive.current && currentLifetime === lifetime.current;
    locked.current = true;
    setBusy(true);
    setOperationError(null);
    try {
      await work(isCurrent);
    } catch {
      if (isCurrent()) setOperationError({ key, retry: work });
    } finally {
      if (isCurrent()) {
        locked.current = false;
        setBusy(false);
      }
    }
  };

  const save = (patch: Partial<PetPreferences>) => run(async (isCurrent) => {
    await petsClient.preferences(patch);
    if (isCurrent()) await refresh();
  }, "pets.saveError");
  const showMini = () => {
    if (!library) return;
    const visible = !library.preferences.miniVisible;
    void run(async (isCurrent) => {
      await petsClient.setVisible(visible);
      if (isCurrent()) await refresh();
    }, "pets.saveError");
  };
  const openImport = () => run(async (isCurrent) => {
    const next = await petsClient.previewImport();
    if (isCurrent()) setPreview(next);
  }, "pets.importError");
  const confirmImport = () => {
    if (!preview) return;
    const token = preview.token;
    void run(async (isCurrent) => {
      // Only the host-issued capability token crosses this boundary, never a path.
      await petsClient.confirmImport(token);
      if (!isCurrent()) return;
      setPreview(null);
      await refresh();
    }, "pets.importError");
  };
  const cancelImport = () => {
    if (locked.current) return;
    setPreview(null);
    setOperationError(null);
  };
  const retryLoad = () => {
    void run(async (isCurrent) => {
      await refresh();
      if (isCurrent()) setSnapshotRevision((value) => value + 1);
    }, "pets.saveError");
  };

  const disabled = busy || !!preview;
  const preferences = library?.preferences;
  const search = query.trim().toLocaleLowerCase();
  const pets = library?.pets.filter((pet) =>
    !search || `${pet.displayName} ${pet.description}`.toLocaleLowerCase().includes(search),
  ) ?? [];

  return <div className="pets-settings" aria-busy={busy || (!library && !loadError)}>
    <div className="pets-toolbar">
      <Button type="button" disabled={disabled} onClick={retryLoad}>{t("pets.refresh")}</Button>
      <Button type="button" ref={importButton} disabled={disabled || !library} onClick={() => { void openImport(); }}>{t("pets.import")}</Button>
      <Button type="button" disabled={disabled || !library} onClick={onCreate}>{t("pets.create")}</Button>
    </div>
    <div className="pets-feedback" aria-live="polite">
      {busy && <p role="status">{t("pets.working")}</p>}
      {!library && !loadError && <p role="status">{t("pets.loading")}</p>}
      {loadError && <div className="pets-error" role="alert">
        <p>{t("pets.loadError")}</p>
        <Button type="button" size="sm" disabled={disabled} onClick={retryLoad}>{t("pets.retry")}</Button>
      </div>}
      {operationError && <div className="pets-error" role="alert">
        <p>{t(operationError.key)}</p>
        <Button type="button" size="sm" disabled={busy} onClick={() => { void run(operationError.retry, operationError.key); }}>{t("pets.retry")}</Button>
      </div>}
    </div>

    {preview && <SettingsCard title={t("pets.importPreview")}>
      <div className="pets-import-preview" role="region" aria-label={t("pets.importPreview")}>
        <PetSprite pet={preview.pet} dataUrl={preview.dataUrl} />
        <div className="pets-import-copy">
          <h4>{preview.pet.displayName}</h4>
          <p>{preview.pet.description}</p>
          <p className="pets-hint">{t("pets.importReview")}</p>
          <div className="pets-actions">
            <Button type="button" variant="primary" disabled={busy} onClick={confirmImport}>{t("pets.confirmImport")}</Button>
            <Button type="button" ref={cancelButton} disabled={busy} onClick={cancelImport}>{t("pets.cancel")}</Button>
          </div>
        </div>
      </div>
    </SettingsCard>}

    {library && <>
      <SettingsCard title={t("pets.gallery")}>
        <div className="pets-gallery-content">
          <Input aria-label={t("pets.search")} placeholder={t("pets.search")} value={query} maxLength={80}
            disabled={disabled} onChange={(event) => setQuery(event.target.value)} />
          <div className="pets-gallery" role="group" aria-label={t("pets.gallery")}>
            <Button type="button" className="pets-choice" aria-pressed={preferences!.selectedPet === null} disabled={disabled}
              onClick={() => { void save({ selectedPet: null }); }}>
              <span className="pets-choice-preview pets-none" aria-hidden="true">∅</span>
              <span className="pets-choice-name">{t("pets.none")}</span>
              <span className="pets-choice-description">{t("pets.noneHelp")}</span>
              <span className="pets-choice-status">{preferences!.selectedPet === null ? t("pets.selected") : t("pets.select")}</span>
            </Button>
            {pets.map((pet) => <PetChoice key={pet.id} pet={pet} selected={preferences!.selectedPet === pet.id}
              disabled={disabled} onSelect={() => { void save({ selectedPet: pet.id }); }} />)}
          </div>
          {search && !pets.length && <p className="pets-hint" role="status">{t("pets.noMatches")}</p>}
        </div>
      </SettingsCard>
      <SettingsCard title={t("pets.miniTitle")}>
        <SettingsRow title={t("pets.visible")} description={t("pets.visibleHelp")}>
          <SettingsToggle label={t("pets.visible")} checked={preferences!.miniVisible} disabled={disabled} busy={busy} onChange={showMini} />
        </SettingsRow>
        <SettingsRow title={t("pets.alwaysOnTop")}>
          <SettingsToggle label={t("pets.alwaysOnTop")} checked={preferences!.alwaysOnTop} disabled={disabled} busy={busy}
            onChange={() => { void save({ alwaysOnTop: !preferences!.alwaysOnTop }); }} />
        </SettingsRow>
        <SettingsRow title={t("pets.scale")}>
          <SettingsMenuSelect label={t("pets.scale")} value={String(preferences!.scale)} disabled={disabled} busy={busy}
            options={[
              { id: "0.75", label: t("pets.scaleSmall") },
              { id: "1", label: t("pets.scaleDefault") },
              { id: "1.25", label: t("pets.scaleLarge") },
              { id: "1.5", label: t("pets.scaleExtraLarge") },
            ]} onChange={(value) => { void save({ scale: Number(value) }); }} />
        </SettingsRow>
        <SettingsRow title={t("pets.followPointer")} description={t("pets.followPointerHelp")}>
          <SettingsToggle label={t("pets.followPointer")} checked={preferences!.followPointer} disabled={disabled} busy={busy}
            onChange={() => { void save({ followPointer: !preferences!.followPointer }); }} />
        </SettingsRow>
        <SettingsRow title={t("pets.shortcut")} detail={t("pets.shortcutHelp")}>
          {shortcutError && <span className="pets-error" role="alert">{t("pets.shortcutError")}</span>}
          {snapshotError && <div className="pets-error" role="alert">
            <span>{t("pets.snapshotError")}</span>
            <Button type="button" size="sm" disabled={disabled} onClick={retryLoad}>{t("pets.retry")}</Button>
          </div>}
        </SettingsRow>
      </SettingsCard>
    </>}
  </div>;
}
