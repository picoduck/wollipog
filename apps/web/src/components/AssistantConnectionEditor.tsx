import React, { useState } from "react";
import type { AssistantConnection, AssistantConnectionsView, AssistantGrant } from "../assistant-connections.js";
import { assistantOperationTitle } from "../assistant-connections.js";
import { ChoiceRows } from "./ui/ChoiceControls.js";
import { SegmentedRow, SelectRow, SettingsGroup, StaticRow, SwitchRow } from "./ui/SettingsRows.js";

const MANAGEMENT_OPTIONS = [
  { value: "all", label: "Full Access", description: "Allows all current and future management operations the granting owner can perform." },
  { value: "selected", label: "Configured", description: "Allows only the management operations selected below." },
];
const PROJECT_OPTIONS = [
  { value: "all", label: "All Projects" },
  { value: "selected", label: "Selected Projects" },
];

function toggle(values: string[], id: string): string[] {
  return values.includes(id) ? values.filter(value => value !== id) : [...values, id];
}

export function AssistantConnectionEditor({
  connection, view, busy, onSave,
}: {
  connection?: AssistantConnection;
  view: AssistantConnectionsView;
  busy: boolean;
  onSave(name: string, grant: AssistantGrant): void;
}) {
  const [name, setName] = useState(connection?.name ?? "");
  const [operations, setOperations] = useState<AssistantGrant["operations"]>(connection?.grant.operations ?? "all");
  const [projects, setProjects] = useState<AssistantGrant["projects"]>(connection?.grant.projects ?? "all");
  const [confirmation, setConfirmation] = useState(connection?.grant.destructiveConfirmation ?? "none");
  const disabled = busy || connection?.revoked === true;
  const operationDescriptions = new Map(view.operations.map(operation => [operation.name, operation.description]));
  const projectNames = new Map(view.projects.map(project => [project.id, project.name]));
  const operationIds = [...new Set([...operationDescriptions.keys(), ...(operations === "all" ? [] : operations)])];
  const projectIds = [...new Set([...projectNames.keys(), ...(projects === "all" ? [] : projects)])];
  const operationDescription = (id: string) => operationDescriptions.get(id)?.replace(
    /\b\w+_\w+\b/g,
    word => operationDescriptions.has(word) ? assistantOperationTitle(word) : word,
  ) ?? "This operation is no longer registered on this server.";

  return (
    <form className="form" onSubmit={event => {
      event.preventDefault();
      if (!disabled && name.trim()) onSave(name, { operations, projects, destructiveConfirmation: confirmation });
    }}>
      <label className="field">
        <span>Connection Name</span>
        <input required maxLength={80} autoComplete="off" value={name} disabled={disabled} onChange={event => setName(event.target.value)} />
      </label>
      <SettingsGroup title="Access">
        <SegmentedRow title="Management Access" options={MANAGEMENT_OPTIONS} value={operations === "all" ? "all" : "selected"}
          disabled={disabled} block onChange={value => setOperations(value === "all" ? "all" : [])} />
        <SelectRow title="Projects" options={PROJECT_OPTIONS} value={projects === "all" ? "all" : "selected"}
          disabled={disabled} onChange={value => setProjects(value === "all" ? "all" : [])} />
        <SwitchRow title="Ask Before Destructive Actions" checked={confirmation === "confirm"}
          description={connection?.threadId
            ? "Wollipog Assistant threads always ask before destructive actions."
            : "Require a preview and confirmation before destructive actions."}
          disabled={disabled || Boolean(connection?.threadId)}
          onClick={() => setConfirmation(confirmation === "confirm" ? "none" : "confirm")} />
      </SettingsGroup>
      {projects !== "all" && (
        <SettingsGroup title="Allowed Projects" intro="Only selected projects are allowed. Resources without a project are excluded.">
          {projectIds.length ? <ChoiceRows label="Allowed Projects" multiple value={projects}
            onChange={id => setProjects(toggle(projects, id))}
            options={projectIds.map(id => ({ value: id, title: projectNames.get(id) ?? id, disabled }))} />
            : <StaticRow title="No Projects Available" />}
        </SettingsGroup>
      )}
      <div className="assistant-editor-save">
        <button type="submit" className="btn primary" disabled={disabled || !name.trim()}>
          {connection ? "Save Connection" : "Create Connection"}
        </button>
      </div>
      {operations !== "all" && (
        <SettingsGroup title="Allowed Operations">
          {operationIds.length ? <ChoiceRows label="Allowed Operations" multiple value={operations}
            onChange={id => setOperations(toggle(operations, id))}
            options={operationIds.map(id => ({
              value: id,
              title: assistantOperationTitle(id),
              description: <><code>{id}</code> · {operationDescription(id)}</>,
              disabled,
            }))} /> : <StaticRow title="No Operations Available" />}
        </SettingsGroup>
      )}
    </form>
  );
}
