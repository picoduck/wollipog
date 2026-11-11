import React, { useEffect, useId, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import { useInstanceScope } from "../instance-scope.js";
import type { AssistantActivity, AssistantConnection, AssistantConnectionsView, AssistantGrant } from "../assistant-connections.js";
import { Modal } from "./Modal.js";
import { useFeedback } from "./FeedbackProvider.js";
import { secretValueRef } from "./ui/secret-input.js";
import { Notice } from "./Notice.js";
import { ChoiceRows, Select } from "./ui/ChoiceControls.js";
import { LinkRow, SettingsGroup, StaticRow, ValueRow } from "./ui/SettingsRows.js";

export function AssistantConnectionsPanel() {
  return <AssistantConnectionsLauncher key={useInstanceScope()} />;
}
function AssistantConnectionsLauncher() {
  const [open, setOpen] = useState(false);
  return <>
    <SettingsGroup title="Assistants" scope="This Server">
      <LinkRow title="Manage Assistant Connections" description="Organization owners can grant, inspect or revoke standing access for external assistants." hasPopup="dialog" onClick={() => setOpen(true)} />
    </SettingsGroup>
    {open && <AssistantConnectionsDialog onClose={() => setOpen(false)} />}
  </>;
}

/** Unmounting (close or instance switch) discards credentials. Never persist them in browser storage. */
export function AssistantConnectionsDialog({onClose}: {onClose(): void}) {
  const api = useApi();
  const [view, setView] = useState<AssistantConnectionsView | null>(null);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [activity, setActivity] = useState<AssistantActivity[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const {confirm: askConfirm} = useFeedback();
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void api.assistantConnections().then(data => { if (mounted.current) setView(data); }, cause => { if (mounted.current) setError(cause instanceof Error ? cause.message : "Couldn't load Assistant Connections."); });
    return () => { mounted.current = false; };
  }, [api]);
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (cause) { if (mounted.current) setError(`${cause instanceof Error ? cause.message : "Couldn't reach Wollipog."} If a change may have been delivered, refresh and inspect the connection before trying it again.`); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const update = (connection: AssistantConnection) => setView(current => current ? {...current, connections: [...current.connections.filter(c => c.id !== connection.id), connection]} : current);
  const connection = view?.connections.find(c => c.id === selected);
  const leave = () => { setSelected(null); setActivity(null); setSecret(null); setReveal(false); setNotice(""); };
  const copyText = async (value: string, credential = false) => {
    setError("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      if (mounted.current) setNotice(credential ? "Credential copied. Keep it private." : "ID copied.");
    } catch {
      if (mounted.current) setError(credential ? "Couldn't copy the credential. Choose Show Credential, then select the text and copy it manually." : "Couldn't copy the ID. Select the ID field and copy it manually.");
    }
  };
  const changeCredential = (action: "rotate" | "revoke") => void run(async () => {
    if (!connection) return;
    const title = action === "rotate" ? "Rotate Credential" : "Revoke Connection";
    const approved = await askConfirm({title, confirmLabel: title, tone: "danger", message: action === "rotate"
      ? `The old credential for “${connection.name}” stops working immediately. Update the assistant with the new credential shown once after rotation.`
      : `Permanently disable “${connection.name}”. Already completed actions are retained; create a new connection to restore access.`});
    if (!approved || !mounted.current) return;
    const response = action === "rotate" ? await api.rotateAssistantConnection(connection.id) : await api.revokeAssistantConnection(connection.id);
    if (!mounted.current) return;
    update(response.connection); setActivity(null);
    if ("token" in response && typeof response.token === "string") { setSecret(response.token); setReveal(false); }
    else setNotice("Connection revoked. Later authorization checks will refuse its access.");
  });
  const editor = view && (selected === "new" || connection) && <ConnectionEditor key={selected} connection={connection} view={view} busy={busy} onSave={(name, grant) => void run(async () => {
    const response = connection ? await api.configureAssistantConnection(connection.id, {name, grant, expectedRevision: connection.revision}) : await api.createAssistantConnection({name, grant});
    if (!mounted.current) return;
    update(response.connection); setSelected(response.connection.id); setNotice(connection ? "Connection saved. The next authorization check uses these grants." : "Connection created.");
    if ("token" in response && typeof response.token === "string") { setSecret(response.token); setReveal(false); }
  })} />;
  return <Modal title="Assistant Connections" description="Standing access issued by your organization owner on this server." size="lg" phoneSheet="full" onClose={onClose}
    footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
    {error && <Notice tone="danger" role="alert">{error}</Notice>}
    {notice && <Notice tone="success" role="status">{notice}</Notice>}
    {busy && <p role="status">Working…</p>}
    {!view && !error && <p role="status">Loading connections…</p>}
    {!view && error && <button className="btn" type="button" onClick={() => void run(async () => { const data = await api.assistantConnections(); if (mounted.current) setView(data); })}>Try Again</button>}
    {secret ? <>
      <Notice tone="warning" title="Save Your Credential">This credential is available only now. Store it securely in your assistant's connection configuration. Closing this dialog or dismissing it removes it from this window.</Notice>
      <label className="field"><span>Assistant Credential</span><input autoComplete="off" spellCheck={false} readOnly type={reveal ? "text" : "password"} ref={secretValueRef(secret)} /></label>
      <div className="field-row"><button type="button" className="btn" onClick={() => { setReveal(v => !v); setError(""); }}>{reveal ? "Hide Credential" : "Show Credential"}</button>
        <button type="button" className="btn" onClick={() => void copyText(secret, true)}>Copy Credential</button>
        <button type="button" className="btn primary" onClick={() => { setSecret(null); setReveal(false); setNotice(""); }}>Dismiss Credential</button></div>
    </> : view && <>
      {selected === null ? <>
        <SettingsGroup title="Control Plane" scope="This Installation">
          <ValueRow title="Installation Name" value={view.installation.name} />
        </SettingsGroup>
        <IdentityField title="Installation ID" value={view.installation.id} onCopy={() => void copyText(view.installation.id)} />
        {view.installation.canRename && <InstallationName key={view.installation.name} initial={view.installation.name} busy={busy} onSave={name => void run(async () => { const installation = await api.renameAssistantInstallation(name); if (mounted.current) { setView(current => current ? {...current, installation: {...current.installation, ...installation}} : current); setNotice("Installation name saved."); } })} />}
        <SettingsGroup title="Your Connections" action={<button className="btn sm" disabled={busy} type="button" onClick={() => { setSelected("new"); setNotice(""); }}>New Connection</button>}>
          {view.connections.length === 0 ? <StaticRow title="No Connections" description="Create a separately named connection for each assistant or installation relationship." /> : view.connections.map(c => <LinkRow key={c.id} title={c.name} trailing={c.revoked ? "Revoked" : "Active"} description={`${c.grant.operations === "all" ? "Full Access" : "Configured Access"} · ${c.grant.projects === "all" ? "All Projects" : `${c.grant.projects.length} Selected Projects`}`} disabled={busy} onClick={() => { setSelected(c.id); setActivity(null); setNotice(""); }} />)}
        </SettingsGroup>
        <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => { const data = await api.assistantConnections(); if (mounted.current) setView(data); })}>Refresh Connections</button>
      </> : <>
        <button type="button" className="btn ghost" disabled={busy} onClick={leave}>Back to Connections</button>
        {connection && <SettingsGroup title={connection.name}>
          <ValueRow title="Status" value={connection.revoked ? "Revoked" : "Active"} />
          <ValueRow title="Grant Revision" value={String(connection.revision)} />
        </SettingsGroup>}
        {connection && <IdentityField title="Connection ID" value={connection.id} onCopy={() => void copyText(connection.id)} />}
        {connection?.revoked ? <details className="disclosure"><summary>Inspect Revoked Grants</summary>{editor}</details> : editor}
        {connection && !connection.revoked && <div className="field-row">
          <button type="button" className="btn" disabled={busy} onClick={() => changeCredential("rotate")}>Rotate Credential</button>
          <button type="button" className="btn ghost danger" disabled={busy} onClick={() => changeCredential("revoke")}>Revoke Connection</button>
        </div>}
        {connection && <SettingsGroup title="Activity" intro="Latest 100 actions; this server retains up to 1,000 per connection. No credentials or tool arguments are recorded." action={<button type="button" className="btn sm" disabled={busy} onClick={() => void run(async () => { const result = await api.assistantConnectionActivity(connection.id); if (mounted.current) setActivity(result.activity); })}>Refresh Activity</button>}>
          {activity === null ? <StaticRow title="Activity Not Loaded" /> : activity.length === 0 ? <StaticRow title="No Activity" /> : activity.map((item, i) => <ValueRow key={i} title={operationTitle(item.operation)} value={operationTitle(item.outcome)} description={<><span>Assistant: {item.assistant.name}</span><br /><span>Target: {item.targetLabel}</span><br />{new Date(item.created_at).toLocaleString()} · Grant {item.grant_revision}</>} />)}
        </SettingsGroup>}
      </>}
    </>}
  </Modal>;
}

function IdentityField({title, value, onCopy}: {title: string; value: string; onCopy(): void}) {
  const id = useId();
  return <div className="field"><label className="field-label" htmlFor={id}>{title}</label><div className="assistant-id-control"><input id={id} readOnly value={value} /><button className="btn" type="button" aria-label={`Copy ${title}`} onClick={onCopy}>Copy ID</button></div></div>;
}

function operationTitle(value: string): string {
  const words = value.split("_");
  return words.map((word, i) => i > 0 && i < words.length - 1 && ["a", "an", "the", "and", "or", "but", "nor", "of", "to", "in", "for", "at", "by", "on", "as", "per", "via"].includes(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function InstallationName({initial, busy, onSave}: {initial: string; busy: boolean; onSave(name: string): void}) {
  const [name, setName] = useState(initial);
  return <form className="form" onSubmit={event => { event.preventDefault(); onSave(name); }}>
    <label className="field"><span>Installation Display Name</span><input required maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
    <button className="btn" disabled={busy || !name.trim() || name === initial}>Save Installation Name</button>
  </form>;
}

function ConnectionEditor({connection, view, busy, onSave}: {connection?: AssistantConnection; view: AssistantConnectionsView; busy: boolean; onSave(name: string, grant: AssistantGrant): void}) {
  const [name, setName] = useState(connection?.name ?? "");
  const [operations, setOperations] = useState<AssistantGrant["operations"]>(connection?.grant.operations ?? "all");
  const [projects, setProjects] = useState<AssistantGrant["projects"]>(connection?.grant.projects ?? "all");
  const [confirmation, setConfirmation] = useState(connection?.grant.destructiveConfirmation ?? "none");
  useEffect(() => {
    setName(connection?.name ?? "");
    setOperations(connection?.grant.operations ?? "all");
    setProjects(connection?.grant.projects ?? "all");
    setConfirmation(connection?.grant.destructiveConfirmation ?? "none");
  }, [connection]);
  const operationChoices = [...new Set([...view.operations.map(o => o.name), ...(Array.isArray(operations) ? operations : [])])];
  const projectChoices = [...new Set([...view.projects.map(p => p.id), ...(Array.isArray(projects) ? projects : [])])];
  const toggle = (values: string[], id: string) => values.includes(id) ? values.filter(v => v !== id) : [...values, id];
  return <form className="form" onSubmit={event => { event.preventDefault(); onSave(name, {operations, projects, destructiveConfirmation: confirmation}); }}>
    <fieldset className="form assistant-fields" disabled={busy || connection?.revoked}>
      <legend>{connection ? "Connection Settings" : "New Connection"}</legend>
      <label className="field"><span>Connection Name</span><input required maxLength={80} autoComplete="off" value={name} onChange={event => setName(event.target.value)} /></label>
      <div className="field"><span className="field-label">Management Access</span><Select label="Management Access" value={operations === "all" ? "all" : "selected"} options={[{value: "all", label: "Full Access"}, {value: "selected", label: "Configured Access"}]} disabled={busy || connection?.revoked} onChange={value => setOperations(value === "all" ? "all" : [])} /></div>
      <p className="field-helper">Full Access includes all current and future management operations the granting owner can perform, including unrelated sessions and remote runners. External permissions and compatibility still apply.</p>
      {Array.isArray(operations) && <fieldset className="form assistant-fields"><legend>Allowed Operations</legend><ChoiceRows label="Allowed Operations" multiple value={operations} onChange={id => setOperations(toggle(operations, id))} options={operationChoices.map(id => ({value: id, title: operationTitle(id), disabled: busy || connection?.revoked, description: <><code>{id}</code> — {view.operations.find(o => o.name === id)?.description ?? "Not currently registered on this server."}</>}))} />{operationChoices.length === 0 && <p>No operations are registered.</p>}</fieldset>}
      <div className="field"><span className="field-label">Project Access</span><Select label="Project Access" value={projects === "all" ? "all" : "selected"} options={[{value: "all", label: "All Projects"}, {value: "selected", label: "Selected Projects"}]} disabled={busy || connection?.revoked} onChange={value => setProjects(value === "all" ? "all" : [])} /></div>
      {Array.isArray(projects) && <fieldset className="form assistant-fields"><legend>Allowed Projects</legend><ChoiceRows label="Allowed Projects" multiple value={projects} onChange={id => setProjects(toggle(projects, id))} options={projectChoices.map(id => ({value: id, title: view.projects.find(p => p.id === id)?.name ?? id, disabled: busy || connection?.revoked}))} /><p className="field-helper">Only selected projects are allowed. Resources without a project are excluded. Installation and connection metadata remain readable when granted.</p></fieldset>}
      <div className="field"><span className="field-label">Destructive Confirmation</span><Select label="Destructive Confirmation" value={confirmation} options={[{value: "none", label: "None"}, {value: "confirm", label: "Confirm"}]} disabled={busy || connection?.revoked} onChange={setConfirmation} /></div>
      <p className="field-helper">Confirm requires a preview and short-lived confirmation for destructive operations. None allows granted operations without that extra step.</p>
      <button className="btn primary" disabled={!name.trim()}>{connection ? "Save Connection" : "Create Connection"}</button>
    </fieldset>
  </form>;
}
