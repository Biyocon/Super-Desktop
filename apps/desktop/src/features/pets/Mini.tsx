import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MiniSnapshot } from "@pi-desktop/shared";
import { Button, Textarea } from "../../components/ui";
import { petsClient } from "./client";
import { PetSprite } from "./PetSprite";
import { usePetImage } from "./pet-store";
import { createCaptureController, type CaptureState } from "./capture-controller";
import "./mini.css";

export function Mini() {
  const { t, i18n } = useTranslation();
  const [snapshot, setSnapshot] = useState<MiniSnapshot | null>(null);
  const [error, setError] = useState(false);
  const [capture, setCapture] = useState<CaptureState>({ phase: "idle", draft: null, error: null });
  const [text, setText] = useState("");
  const [opening, setOpening] = useState(false);
  const controller = useRef<ReturnType<typeof createCaptureController> | null>(null);
  const mounted = useRef(false);
  const draftArea = useRef<HTMLDivElement>(null);
  const image = usePetImage(snapshot?.preferences.selectedPet ?? null);
  const pet = snapshot?.pets.find((entry) => entry.id === snapshot.preferences.selectedPet);

  useEffect(() => {
    mounted.current = true;
    const instance = createCaptureController({ changed: (value) => {
      setCapture(value);
      if (value.draft) setText(value.draft.text);
      else if (value.phase === "idle") setText("");
    } });
    controller.current = instance;
    const visibility = () => { if (document.hidden) instance.cancel(); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("beforeunload", instance.cancel);
    return () => {
      mounted.current = false;
      instance.dispose();
      controller.current = null;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("beforeunload", instance.cancel);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    let events = 0;
    const stop = petsClient.onState((value) => { events += 1; if (alive) setSnapshot(value); });
    void petsClient.snapshot().then((value) => { if (alive && !events) setSnapshot(value); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; stop(); };
  }, []);
  useEffect(() => {
    controller.current?.cancel();
  }, [snapshot?.activity.sessionId, snapshot?.visible, snapshot?.captureGeneration, snapshot?.dictationAvailable]);
  useEffect(() => {
    if (!capture.draft) return;
    draftArea.current?.querySelector("textarea")?.focus({ preventScroll: true });
    draftArea.current?.scrollIntoView({ block: "nearest" });
  }, [capture.draft?.token]);
  useEffect(() => {
    if (!snapshot) return;
    document.documentElement.dataset.theme = snapshot.theme;
    document.documentElement.lang = snapshot.language;
    void i18n.changeLanguage(snapshot.language);
  }, [snapshot?.theme, snapshot?.language, i18n]);

  const run = (action: () => Promise<unknown>) => {
    setError(false);
    void action().catch(() => { if (mounted.current) setError(true); });
  };
  const openDraft = async () => {
    if (!capture.draft) return;
    setOpening(true);
    try {
      await petsClient.openDraft({ ...capture.draft, text });
      if (mounted.current) controller.current?.cancel();
    } catch { if (mounted.current) setError(true); }
    finally { if (mounted.current) setOpening(false); }
  };
  const busy = ["requesting", "recording", "transcribing"].includes(capture.phase);
  return <main className="mini-shell" aria-label={t("pets.title")}>
    <div className="mini-drag-handle">{t("pets.miniTitle")}</div>
    <div className="mini-pet-area">
      {pet && image && snapshot?.visible && <PetSprite pet={pet} dataUrl={image} size={156} animation={snapshot.activity.status} followPointer={snapshot.preferences.followPointer} />}
    </div>
    <section className="mini-card">
      <div className="mini-heading">
        <strong>{snapshot?.activity.title || t("pets.noSession")}</strong>
        <Button onClick={() => { controller.current?.cancel(); run(() => petsClient.setVisible(false)); }}>{t("pets.hide")}</Button>
      </div>
      <p role="status" aria-live="polite">{t(`pets.status.${snapshot?.activity.status ?? "idle"}`)}</p>
      <div className="mini-actions">
        <Button onClick={() => run(() => petsClient.action("focus"))}>{t("pets.openApp")}</Button>
        <Button onClick={() => { controller.current?.cancel(); run(() => petsClient.action("newTask")); }}>{t("pets.newTask")}</Button>
        <Button onClick={() => run(() => petsClient.action("settings"))}>{t("pets.settings")}</Button>
      </div>
      <p className="mini-hint">{t("pets.dictationNotice")}</p>
      {!snapshot?.dictationAvailable && <Button onClick={() => run(() => petsClient.action("dictate"))}>{t("pets.configureSpeech")}</Button>}
      {capture.phase === "recording" ? <Button onClick={() => controller.current?.stop()}>{t("pets.stopRecording")}</Button> :
        <Button disabled={busy || !snapshot?.dictationAvailable || !snapshot.activity.sessionId || !snapshot.visible || !!capture.draft} onClick={() => { setError(false); void controller.current?.start(); }}>{t("pets.startRecording")}</Button>}
      {busy && <>
        <span role="status">{t(`pets.capture.${capture.phase}`)}</span>
        <Button onClick={() => controller.current?.cancel()}>{t("common.cancel")}</Button>
      </>}
      {capture.draft && <div ref={draftArea} className="mini-draft">
        <Textarea aria-label={t("pets.draft")} value={text} maxLength={100_000} onChange={(event) => setText(event.target.value)} />
        <div className="mini-actions">
          <Button disabled={opening || !text.trim()} onClick={() => void openDraft()}>{t("pets.openDraft")}</Button>
          <Button disabled={opening} onClick={() => controller.current?.cancel()}>{t("pets.discard")}</Button>
        </div>
      </div>}
      {(error || capture.error || snapshot?.runtimeError) && <p role="alert">{t(capture.error ? `pets.${capture.error}` : "pets.operationFailed")}</p>}
      {snapshot?.shortcutError && <p role="alert">{t("pets.shortcutUnavailable")}</p>}
    </section>
  </main>;
}
