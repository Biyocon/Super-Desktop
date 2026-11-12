import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConductorEntry, ConductorQualityCommand, ConductorPurpose } from "@pi-desktop/shared";
import { Button, Checkbox, Field, Input, SegmentedControl, Textarea } from "../../components/ui";

export const entryLines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
type EntryDraft = Omit<ConductorEntry, "sessionId" | "requestId">;
export function ConductorEntryForm({ commands, disabled, onStart }: {
  commands: ConductorQualityCommand[];
  disabled: boolean;
  onStart: (entry: EntryDraft) => void;
}) {
  const { t } = useTranslation();
  const [purpose, setPurpose] = useState<ConductorPurpose>("analysis");
  const [objective, setObjective] = useState("");
  const [scope, setScope] = useState("");
  const [allowedPaths, setAllowedPaths] = useState("");
  const [excludedPaths, setExcludedPaths] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [materialPaths, setMaterialPaths] = useState("");
  const [qualityCommandIds, setQualityCommandIds] = useState<string[]>([]);
  return <form className="conductor-entry" onSubmit={event => {
    event.preventDefault();
    if (disabled) return;
    onStart({ objective: objective.trim(), purpose, scope: entryLines(scope),
      allowedPaths: purpose === "implementation" ? entryLines(allowedPaths) : [],
      excludedPaths: entryLines(excludedPaths), acceptanceCriteria: entryLines(acceptanceCriteria),
      materialPaths: entryLines(materialPaths), qualityCommandIds: purpose === "implementation" ? qualityCommandIds : [] });
  }}>
    <fieldset disabled={disabled}>
      <legend>{t("conductor.newRun")}</legend>
      <Field label={t("conductor.objective")}><Input name="objective" required maxLength={8192} value={objective} onChange={event => setObjective(event.target.value)} /></Field>
      <SegmentedControl label={t("conductor.purpose")} value={purpose} onChange={setPurpose} options={[
        { value: "analysis", label: t("conductor.analysis") }, { value: "implementation", label: t("conductor.implementation") },
      ]} disabled={disabled} />
      <p>{t("conductor.linesHint")}</p>
      <Field label={t("conductor.scope")}><Textarea name="scope" required rows={2} maxLength={32768} value={scope} onChange={event => setScope(event.target.value)} /></Field>
      {purpose === "implementation" && <Field label={t("conductor.allowedPaths")}><Textarea name="allowedPaths" required rows={2} maxLength={32768} value={allowedPaths} onChange={event => setAllowedPaths(event.target.value)} /></Field>}
      <Field label={t("conductor.excludedPaths")}><Textarea name="excludedPaths" rows={2} maxLength={32768} value={excludedPaths} onChange={event => setExcludedPaths(event.target.value)} /></Field>
      <Field label={t("conductor.acceptanceCriteria")}><Textarea name="acceptanceCriteria" required rows={2} maxLength={32768} value={acceptanceCriteria} onChange={event => setAcceptanceCriteria(event.target.value)} /></Field>
      <Field label={t("conductor.materialPaths")}><Textarea name="materialPaths" rows={2} maxLength={32768} value={materialPaths} onChange={event => setMaterialPaths(event.target.value)} /></Field>
      {purpose === "implementation" && <fieldset>
        <legend>{t("conductor.qualityCommands")}</legend>
        <p>{t("conductor.qualityHint")}</p>
        {commands.map(command => <div key={command.id}>
          <Checkbox label={command.id} checked={qualityCommandIds.includes(command.id)} onChange={event => setQualityCommandIds(ids => event.target.checked ? [...ids, command.id] : ids.filter(id => id !== command.id))} />
          <code>{JSON.stringify(command)}</code>
        </div>)}
      </fieldset>}
      <p>{t("conductor.permissionsHint")}</p>
      <Button type="submit" variant="primary" disabled={disabled || !objective.trim() || !entryLines(scope).length || !entryLines(acceptanceCriteria).length || (purpose === "implementation" && (!entryLines(allowedPaths).length || !qualityCommandIds.length))}>{t("conductor.start")}</Button>
    </fieldset>
  </form>;
}
