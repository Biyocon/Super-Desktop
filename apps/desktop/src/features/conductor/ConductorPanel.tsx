import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import { Button, Field, Select } from "../../components/ui";
import { conductorClient } from "./client";
import { ConductorHistoryController } from "./history-controller";
import { ConductorEntryForm } from "./ConductorEntryForm";
import { ConductorAuthority, ConductorDisclosure, ConductorRunView, ConductorStatus } from "./ConductorRunView";
import "./conductor.css";

export function ConductorPanel({ session, chatRunning = false }: { session: SessionSummary; chatRunning?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className="conductor-panel" aria-label={t("conductor.title")}>
    <Button type="button" className="conductor-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{t(open ? "conductor.close" : "conductor.open")}</Button>
    {open && <div id={id} className="conductor-panel-body"><ConductorContent key={`${session.id}:${session.projectPath ?? ""}:${session.source ?? "desktop"}`} session={session} chatRunning={chatRunning} /></div>}
  </section>;
}

function ConductorContent({ session, chatRunning }: { session: SessionSummary; chatRunning: boolean }) {
  const { t } = useTranslation();
  const controller = useMemo(() => new ConductorHistoryController(session.id, conductorClient), [session.id]);
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [showEntry, setShowEntry] = useState(false);
  useEffect(() => controller.connect(), [controller]);
  const available = state.availability?.available === true;
  const localRepository = !!session.projectPath && (session.source ?? "desktop") === "desktop";
  const active = state.runs.some(run => run.status === "running" || run.status === "owner-waiting");
  return <>
    <h2>{t("conductor.title")}</h2>
    <p>{t("conductor.introduction")}</p>
    <p><strong>{t("conductor.repository")}</strong>: {session.projectPath ?? t("conductor.none")}</p>
    {!localRepository && <p role="status">{t("conductor.noRepository")}</p>}
    <ConductorAuthority />
    {state.availability?.available === false && <p role="alert">{t("conductor.unavailable")} <code>{state.availability.code}</code></p>}
    {state.error && <p role="alert">{t("conductor.error")} <code>{state.error}</code></p>}
    {state.availability?.available && <ConductorDisclosure title={t("conductor.provenance")}><dl className="conductor-provenance">
      <dt>{t("conductor.sourceRevision")}</dt><dd>{state.availability.provenance.revision}</dd>
      <dt>{t("conductor.runtimeVersion")}</dt><dd>{state.availability.provenance.version}</dd>
      <dt>{t("conductor.license")}</dt><dd>{state.availability.provenance.license}</dd>
      <dt>{t("conductor.format")}</dt><dd>{state.availability.provenance.recordFormat}</dd>
      <dt>{t("conductor.artifacts")}</dt><dd><pre>{JSON.stringify(state.availability.provenance.artifacts, null, 2)}</pre></dd>
    </dl></ConductorDisclosure>}
    <div className="conductor-actions">
      <Button type="button" aria-expanded={showEntry} onClick={() => setShowEntry(value => !value)}>{t("conductor.newRun")}</Button>
      <Button type="button" disabled={state.loading} onClick={() => { void controller.refresh(); }}>{t("conductor.refresh")}</Button>
      {state.admissionRequest && <Button type="button" onClick={() => { void controller.cancelAdmission(); }}>{t("conductor.cancelAdmission")}</Button>}
    </div>
    {showEntry && <ConductorEntryForm commands={state.commands} disabled={!available || !localRepository || state.busy || active || chatRunning} onStart={entry => { void controller.start(entry); }} />}
    <p role="status" aria-live="polite">{state.loading ? t("conductor.loading") : state.history ? <>{state.history.index.runId} · <ConductorStatus value={state.history.index.status} /> · {t("conductor.version")} {state.history.index.version}</> : t("conductor.empty")}</p>
    {!!state.runs.length && <Field label={t("conductor.history")}><Select value={state.selectedRunId ?? ""} onChange={event => controller.select(event.target.value)} disabled={state.busy}>
      {state.runs.map(run => <option key={run.runId} value={run.runId}>{run.runId} · {t(`conductor.statuses.${run.status}`)} · {run.version}</option>)}
    </Select></Field>}
    {state.history && <ConductorRunView key={state.history.index.runId} history={state.history} busy={state.busy} engineAvailable={available} onResume={() => { void controller.resume(); }} onCancel={() => { void controller.cancel(); }} onAnswer={(request, approve) => { void controller.authorize(request, approve); }} />}
  </>;
}
