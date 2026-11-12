import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ConductorConsentRequest, ConductorHistory, ConductorStage } from "@pi-desktop/shared";
import { CONDUCTOR_ROLES, roleAvatarUrl, type ConductorRole } from "../../components/AgentAvatar";
import { Badge, Button, Panel } from "../../components/ui";

/** A real button provides the same disclosure through native mouse, Enter and Space. */
export function ConductorDisclosure({ title, children }: { title: ReactNode; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return <div className="conductor-disclosure">
    <Button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{title}</Button>
    {open && <div id={id} className="conductor-detail">{children}</div>}
  </div>;
}

function Portrait({ role }: { role: ConductorRole }) {
  return <img className="agent-avatar" src={roleAvatarUrl(role)} alt="" aria-hidden="true" width={40} height={40} draggable={false} data-conductor-role={role} />;
}
function Stage({ stage }: { stage: ConductorStage | "conductor" }) {
  const { t } = useTranslation();
  return <span className="conductor-stage">{CONDUCTOR_ROLES.includes(stage as ConductorRole) && <Portrait role={stage as ConductorRole} />}<span>{t(`conductor.roles.${stage}`)}</span></span>;
}
export function ConductorStatus({ value }: { value: string }) {
  const { t } = useTranslation();
  return <Badge>{t(`conductor.statuses.${value}`, { defaultValue: value })}</Badge>;
}
function Value({ label, children }: { label: string; children: ReactNode }) {
  return <div className="conductor-value"><dt>{label}</dt><dd>{children}</dd></div>;
}
function Lines({ items }: { items: string[] }) {
  const { t } = useTranslation();
  return items.length ? <ul>{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <span>{t("conductor.none")}</span>;
}
function Consent({ request, busy, onAnswer }: { request: ConductorConsentRequest; busy: boolean; onAnswer: (request: ConductorConsentRequest, approve: boolean) => void }) {
  const { t } = useTranslation();
  return <Panel className="conductor-consent">
    <h4>{t("conductor.consent")}</h4><p>{t("conductor.consentHint")}</p>
    <dl>
      <Value label={t("conductor.consentRequest")}>{request.requestId}</Value>
      <Value label={t("conductor.baselineHash")}>{request.baselineHash}</Value>
      <Value label={t("conductor.sourceFingerprint")}>{request.sourceFingerprint}</Value>
      <Value label={t("conductor.scopeVersion")}>{request.baseline.scopeVersion}</Value>
      <Value label={t("conductor.planVersion")}>{request.baseline.planVersion}</Value>
      <Value label={t("conductor.acceptanceVersion")}>{request.baseline.acceptanceVersion}</Value>
      <Value label={t("conductor.allowedPaths")}><Lines items={request.baseline.allowedPaths} /></Value>
      <Value label={t("conductor.excludedPaths")}><Lines items={request.baseline.excludedPaths} /></Value>
      <Value label={t("conductor.rollbackReference")}>{request.baseline.rollbackReference}</Value>
      <Value label={t("conductor.qualityCommands")}><pre>{JSON.stringify(request.baseline.qualityCommands, null, 2)}</pre></Value>
      <Value label={t("conductor.effectProfile")}><pre>{JSON.stringify(request.effectProfile, null, 2)}</pre></Value>
    </dl>
    <div className="conductor-actions">
      <Button type="button" disabled={busy} onClick={() => onAnswer(request, false)}>{t("conductor.deny")}</Button>
      <Button type="button" variant="primary" disabled={busy} onClick={() => onAnswer(request, true)}>{t("conductor.approve")}</Button>
    </div>
  </Panel>;
}

export function ConductorRunView({ history, busy, engineAvailable, onResume, onCancel, onAnswer }: {
  history: ConductorHistory; busy: boolean; engineAvailable: boolean;
  onResume: () => void; onCancel: () => void;
  onAnswer: (request: ConductorConsentRequest, approve: boolean) => void;
}) {
  const { t } = useTranslation();
  const projection = history.projection;
  return <article className="conductor-run" data-conductor-run={history.index.runId}>
    <h3>{history.index.runId}</h3>
    <dl>
      <Value label={t("conductor.repository")}>{history.index.projectPath}</Value>
      <Value label={t("conductor.version")}>{history.index.version}</Value>
      <Value label={t("conductor.lifecycle")}><ConductorStatus value={history.index.status} /></Value>
    </dl>
    {projection && <>
      <p className="conductor-objective">{projection.objective}</p>
      <dl>
        <Value label={t("conductor.purpose")}>{t(`conductor.${projection.purpose}`)}</Value>
        <Value label={t("conductor.motorStatus")}><ConductorStatus value={projection.motorStatus} /></Value>
        {projection.arbiterDecision && <Value label={t("conductor.reportKinds.decision")}><strong>{projection.arbiterDecision.outcome.toUpperCase()}</strong><Lines items={projection.arbiterDecision.basis} /></Value>}
        <Value label={t("conductor.currentStage")}><Stage stage={projection.currentStage} /></Value>
        <Value label={t("conductor.currentGate")}>{projection.currentGate ? t("conductor.gate", { gate: projection.currentGate }) : t("conductor.none")}</Value>
        <Value label={t("conductor.next")}>{t(`conductor.transitions.${projection.next}`)}</Value>
        <Value label={t("conductor.sourceBaseline")}>{projection.sourceBaseline ?? t("conductor.none")}</Value>
      </dl>
      <ConductorDisclosure title={t("conductor.mandate")}><dl>
        <Value label={t("conductor.emperor")}>{projection.authorityOwner}</Value>
        <Value label={t("conductor.scope")}><Lines items={projection.scope} /></Value>
        <Value label={t("conductor.allowedPaths")}><Lines items={projection.allowedPaths} /></Value>
        <Value label={t("conductor.excludedPaths")}><Lines items={projection.excludedPaths} /></Value>
        <Value label={t("conductor.acceptanceCriteria")}><Lines items={projection.acceptanceCriteria} /></Value>
      </dl></ConductorDisclosure>
      <h4>{t("conductor.workers")}</h4>
      {!projection.workers.length && <p>{t("conductor.noWorkers")}</p>}
      <div className="conductor-workers">{projection.workers.map(worker => <Panel key={worker.dispatchId}>
        <Stage stage={worker.stage} /><ConductorStatus value={worker.status} />
        <p>{worker.task}</p>
        <ConductorDisclosure title={<>{t("conductor.details")} · {worker.workerId} · {worker.dispatchId}</>}><dl>
          <Value label={t("conductor.worker")}>{worker.workerId}</Value>
          <Value label={t("conductor.dispatch")}>{worker.dispatchId}</Value>
          <Value label={t("conductor.task")}>{worker.task}</Value>
          <Value label={t("conductor.mode")}>{worker.mode}</Value>
          <Value label={t("conductor.version")}>{worker.startVersion} → {worker.endVersion ?? t("conductor.none")}</Value>
          <Value label={t("conductor.inputHash")}>{worker.inputHash}</Value>
          <Value label={t("conductor.output")}><pre>{worker.output ?? t("conductor.none")}</pre></Value>
          {worker.error && <Value label={t("conductor.diagnostics")}>{worker.error}</Value>}
        </dl></ConductorDisclosure>
      </Panel>)}</div>
      <h4>{t("conductor.gates")}</h4>
      {!projection.gateHistory.length && <p>{t("conductor.noGates")}</p>}
      {projection.gateHistory.map(gate => <ConductorDisclosure key={gate.index} title={<>{t("conductor.gate", { gate: gate.gate })} · <Stage stage={gate.stage} /> <ConductorStatus value={gate.decision} /></>}>
        <dl>
          <Value label={t("conductor.basis")}><Lines items={gate.basis} /></Value>
          <Value label={t("conductor.evidence")}><Lines items={gate.evidenceReviewed} /></Value>
          <Value label={t("conductor.stateUpdate")}>{gate.stateUpdate}</Value>
          {gate.nextStage && <Value label={t("conductor.next")}><Stage stage={gate.nextStage} /></Value>}
          {gate.defectClass && <Value label={t("conductor.defectClass")}>{gate.defectClass}</Value>}
          {gate.executionBaselineHash && <Value label={t("conductor.baselineHash")}>{gate.executionBaselineHash}</Value>}
        </dl>
      </ConductorDisclosure>)}
      <h4>{t("conductor.reports")}</h4>
      {!projection.reports.length && <p>{t("conductor.noReports")}</p>}
      {projection.reports.map(report => <ConductorDisclosure key={report.id} title={<>{t(`conductor.reportKinds.${report.kind}`)} · <Stage stage={report.stage} /> · {report.id}</>}><pre>{report.body}</pre></ConductorDisclosure>)}
      {!!projection.diagnostics.length && <ConductorDisclosure title={t("conductor.diagnostics")}><pre>{JSON.stringify(projection.diagnostics, null, 2)}</pre></ConductorDisclosure>}
    </>}
    {!!history.resourceIssues.length && <div role="alert"><h4>{t("conductor.diagnostics")}</h4><pre>{JSON.stringify(history.resourceIssues, null, 2)}</pre></div>}
    {history.pendingConsent && <Consent key={history.pendingConsent.requestId} request={history.pendingConsent} busy={busy || !engineAvailable} onAnswer={onAnswer} />}
    <div className="conductor-actions">
      {history.index.status === "interrupted" && projection?.next === "validate-resume" && <Button type="button" disabled={busy || !engineAvailable || !!history.resourceIssues.length} onClick={onResume}>{t("conductor.resume")}</Button>}
      {["running", "owner-waiting", "interrupted"].includes(history.index.status) && <Button type="button" disabled={busy} onClick={onCancel}>{t("conductor.cancel")}</Button>}
    </div>
    <ConductorDisclosure title={t("conductor.rawRecord")}><pre>{JSON.stringify({ checkpoint: history.checkpoint, intake: history.intake }, null, 2)}</pre></ConductorDisclosure>
  </article>;
}

export function ConductorAuthority() {
  const { t } = useTranslation();
  return <div className="conductor-authority">
    <div className="conductor-authority-link"><strong>{t("conductor.emperor")}</strong><span aria-hidden="true">→</span><Stage stage="conductor" /></div>
    <p>{t("conductor.relation")}</p>
    <ConductorDisclosure title={t("conductor.specialistRoles")}><div className="conductor-roles">{CONDUCTOR_ROLES.filter(role => role !== "conductor").map(role => <Stage key={role} stage={role} />)}</div></ConductorDisclosure>
  </div>;
}
