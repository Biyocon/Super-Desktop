import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, SpeechProtocolInfo } from "@pi-desktop/shared";
import { Button, Input } from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { SettingsCard, SettingsRow } from "../settings/primitives";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";

export function DictationSettings({ saveSettings }: { saveSettings: (patch: Partial<AppSettings>) => Promise<void> }) {
  const { t } = useTranslation();
  const settings = useAppStore((state) => state.settings);
  const providers = useAppStore((state) => state.providers);
  const binding = settings?.speech?.transcribe;
  const [providerId, setProviderId] = useState(binding?.providerId ?? "");
  const [modelId, setModelId] = useState(binding?.modelId ?? "");
  const [protocol, setProtocol] = useState(binding?.protocol ?? "openai_audio");
  const [protocols, setProtocols] = useState<SpeechProtocolInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);
  const locked = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setProviderId(binding?.providerId ?? ""); setModelId(binding?.modelId ?? ""); setProtocol(binding?.protocol ?? "openai_audio");
  }, [binding]);
  useEffect(() => {
    let cancelled = false;
    void api.speechStatus().then((status) => { if (!cancelled) setProtocols(status.protocols.filter((entry) => entry.roles.includes("transcribe"))); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [revision]);
  const save = async () => {
    if (locked.current || !settings) return;
    locked.current = true; setBusy(true); setError(false);
    try {
      const speech = { ...useAppStore.getState().settings?.speech };
      if (providerId) {
        const previous = speech.transcribe;
        const compatible = previous?.providerId === providerId && previous.protocol === protocol;
        speech.transcribe = { ...(compatible ? previous : {}), providerId, modelId: modelId.trim(), protocol };
      }
      else delete speech.transcribe;
      await saveSettings({ speech });
    } catch { if (mounted.current) setError(true); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const providerOptions = [{ id: "", label: t("pets.none") }, ...providers.filter((entry) => entry.enabled).map((entry) => ({ id: entry.id, label: entry.name }))];
  return <SettingsCard title={t("pets.dictationSettings")} description={t("pets.dictationNotice")}>
    <SettingsRow title={t("settings.providers")}>
      <SettingsMenuSelect label={t("settings.providers")} value={providerId} disabled={busy} options={providerOptions} onChange={setProviderId} />
    </SettingsRow>
    <SettingsRow title={t("pets.speechProtocol")}>
      <SettingsMenuSelect label={t("pets.speechProtocol")} value={protocol} disabled={busy || !providerId} options={protocols.map((entry) => ({ id: entry.id, label: entry.label }))} onChange={setProtocol} />
    </SettingsRow>
    <SettingsRow title={t("settings.models")}>
      <Input aria-label={t("settings.models")} maxLength={256} value={modelId} disabled={busy || !providerId} onChange={(event) => setModelId(event.target.value)} />
    </SettingsRow>
    <SettingsRow title={t("pets.configureSpeech")}>
      {error && <span role="alert">{t("pets.saveError")}</span>}
      {error && <Button disabled={busy} onClick={() => { setError(false); setRevision((value) => value + 1); }}>{t("pets.retry")}</Button>}
      <Button disabled={busy || (!!providerId && (!modelId.trim() || !protocols.some((entry) => entry.id === protocol) || !providers.some((entry) => entry.id === providerId && entry.enabled)))} onClick={() => void save()}>{t(busy ? "common.saving" : "common.save")}</Button>
    </SettingsRow>
  </SettingsCard>;
}
