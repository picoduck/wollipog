import React, { useEffect, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import { useInstanceScope } from "../instance-scope.js";
import type { AssistantActivity, AssistantConnection, AssistantConnectionsView, AssistantGrant } from "../assistant-connections.js";
import { Modal } from "./Modal.js";
import { Notice } from "./Notice.js";
import { ChoiceRow } from "./ui/ChoiceControls.js";
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
  const [confirm, setConfirm] = useState<"rotate" | "revoke" | null>(null);
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
  const leave = () => { setSelected(null); setActivity(null); setConfirm(null); setSecret(null); setReveal(false); setNotice(""); };
  return <Modal title="Assistant Connections" description="Standing access issued by your organization owner on this server." size="lg" phoneSheet="full" onClose={onClose}
    footer={<button type="button" className="btn" onClick={onClose}>Done</button>}>
    {error && <Notice tone="danger" role="alert">{error}</Notice>}
    {notice && <Notice tone="success" role="status">{notice}</Notice>}
    {busy && <p role="status">Working…</p>}
    {!view && !error && <p role="status">Loading connections…</p>}
    {!view && error && <button className="btn" type="button" onClick={() => void run(async () => { const data = await api.assistantConnections(); if (mounted.current) setView(data); })}>Try Again</button>}
    {secret ? <>
      <Notice tone="warning" title="Save Your Credential">This credential is available only now. Store it securely in your assistant's connection configuration. Closing this dialog or dismissing it removes it from this window.</Notice>
      <label className="field"><span>Assistant Credential</span><input autoComplete="off" spellCheck={false} readOnly type={reveal ? "text" : "password"} value={secret} /></label>
      <div className="field-row"><button type="button" className="btn" onClick={() => setReveal(v => !v)}>{reveal ? "Hide Credential" : "Show Credential"}</button>
        <button type="button" className="btn" onClick={() => void run(async () => { await navigator.clipboard.writeText(secret); if (mounted.current) setNotice("Credential copied. Keep it private."); })}>Copy Credential</button>
        <button type="button" className="btn primary" onClick={() => { setSecret(null); setReveal(false); setNotice(""); }}>Dismiss Credential</button></div>
    </> : view && <>
      {selected === null ? <>
        <SettingsGroup title="Control Plane" scope="This Installation">
          <ValueRow title="Installation ID" value={view.installation.id} mono wrap />
          <ValueRow title="Installation Name" value={view.installation.name} />
        </SettingsGroup>
        {view.installation.canRename && <InstallationName key={view.installation.name} initial={view.installation.name} busy={busy} onSave={name => void run(async () => { const installation = await api.renameAssistantInstallation(name); if (mounted.current) { setView(current => current ? {...current, installation: {...current.installation, ...installation}} : current); setNotice("Installation name saved."); } })} />}
        <SettingsGroup title="Your Connections" action={<button className="btn sm" disabled={busy} type="button" onClick={() => { setSelected("new"); setNotice(""); }}>New Connection</button>}>
          {view.connections.length === 0 ? <StaticRow title="No Connections" description="Create a separately named connection for each assistant or installation relationship." /> : view.connections.map(c => <LinkRow key={c.id} title={c.name} trailing={c.revoked ? "Revoked" : "Active"} description={`${c.grant.operations === "all" ? "Full Access" : "Configured Access"} · ${c.grant.projects === "all" ? "All Projects" : `${c.grant.projects.length} Selected Projects`}`} disabled={busy} onClick={() => { setSelected(c.id); setActivity(null); setNotice(""); }} />)}
        </SettingsGroup>
        <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => { const data = await api.assistantConnections(); if (mounted.current) setView(data); })}>Refresh Connections</button>
      </> : <>
        <button type="button" className="btn ghost" disabled={busy} onClick={leave}>Back to Connections</button>
        {connection && <SettingsGroup title={connection.name}>
          <ValueRow title="Connection ID" value={connection.id} mono wrap />
          <ValueRow title="Status" value={connection.revoked ? "Revoked" : "Active"} />
          <ValueRow title="Grant Revision" value={String(connection.revision)} />
        </SettingsGroup>}
        {(selected === "new" || connection) && <ConnectionEditor key={selected} connection={connection} view={view} busy={busy} onSave={(name, grant) => void run(async () => {
          const response = connection ? await api.configureAssistantConnection(connection.id, {name, grant}) : await api.createAssistantConnection({name, grant});
          if (!mounted.current) return;
          update(response.connection); setSelected(response.connection.id); setNotice(connection ? "Connection saved. The next authorization check uses these grants." : "Connection created.");
          if ("token" in response && typeof response.token === "string") { setSecret(response.token); setReveal(false); }
        })} />}
        {connection && !connection.revoked && <div className="field-row">
          <button type="button" className="btn" disabled={busy} onClick={() => setConfirm("rotate")}>Rotate Credential</button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => setConfirm("revoke")}>Revoke Connection</button>
        </div>}
        {connection && confirm && <Notice tone="warning" title={confirm === "rotate" ? "Rotate This Credential?" : "Revoke This Connection?"} actions={<>
          <button type="button" className="btn danger sm" disabled={busy} onClick={() => void run(async () => {
            const response = confirm === "rotate" ? await api.rotateAssistantConnection(connection.id) : await api.revokeAssistantConnection(connection.id);
            if (!mounted.current) return;
            update(response.connection); setConfirm(null); setActivity(null);
            if ("token" in response && typeof response.token === "string") { setSecret(response.token); setReveal(false); } else setNotice("Connection revoked. Later authorization checks will refuse its access.");
          })}>{confirm === "rotate" ? "Confirm Rotation" : "Confirm Revocation"}</button>
          <button type="button" className="btn sm" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
        </>}>{confirm === "rotate" ? "The old credential stops working immediately. Update the assistant with the new credential shown once after rotation." : "This permanently disables the connection. Already completed actions are retained; create a new connection to restore access."}</Notice>}
        {connection && <SettingsGroup title="Activity" intro="Latest 100 actions; this server retains up to 1,000 per connection. No credentials or tool arguments are recorded." action={<button type="button" className="btn sm" disabled={busy} onClick={() => void run(async () => { const result = await api.assistantConnectionActivity(connection.id); if (mounted.current) setActivity(result.activity); })}>Refresh Activity</button>}>
          {activity === null ? <StaticRow title="Activity Not Loaded" /> : activity.length === 0 ? <StaticRow title="No Activity" /> : activity.map((item, i) => <ValueRow key={i} title={operationTitle(item.operation)} value={operationTitle(item.outcome)} description={<>{new Date(item.created_at).toLocaleString()} · Grant {item.grant_revision}<br /><code>{item.target_json}</code></>} />)}
        </SettingsGroup>}
      </>}
    </>}
  </Modal>;
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
      <label className="field"><span>Management Access</span><select value={operations === "all" ? "all" : "selected"} onChange={event => setOperations(event.target.value === "all" ? "all" : [])}><option value="all">Full Access</option><option value="selected">Configured Access</option></select></label>
      <p className="field-helper">Full Access includes all current and future management operations the granting owner can perform, including unrelated sessions and remote runners. External permissions and compatibility still apply.</p>
      {Array.isArray(operations) && <fieldset className="form assistant-fields"><legend>Allowed Operations</legend>{operationChoices.map(id => <ChoiceRow key={id} type="checkbox" title={operationTitle(id)} checked={operations.includes(id)} disabled={busy || connection?.revoked} onSelect={() => setOperations(toggle(operations, id))} description={<><code>{id}</code> — {view.operations.find(o => o.name === id)?.description ?? "Not currently registered on this server."}</>} />)}{operationChoices.length === 0 && <p>No operations are registered.</p>}</fieldset>}
      <label className="field"><span>Project Access</span><select value={projects === "all" ? "all" : "selected"} onChange={event => setProjects(event.target.value === "all" ? "all" : [])}><option value="all">All Projects</option><option value="selected">Selected Projects</option></select></label>
      {Array.isArray(projects) && <fieldset className="form assistant-fields"><legend>Allowed Projects</legend>{projectChoices.map(id => <ChoiceRow key={id} type="checkbox" title={view.projects.find(p => p.id === id)?.name ?? id} checked={projects.includes(id)} disabled={busy || connection?.revoked} onSelect={() => setProjects(toggle(projects, id))} />)}<p className="field-helper">Only selected projects are allowed. Resources without a project are excluded. Installation and connection metadata remain readable when granted.</p></fieldset>}
      <label className="field"><span>Destructive Confirmation</span><select value={confirmation} onChange={event => setConfirmation(event.target.value as "none" | "confirm")}><option value="none">None</option><option value="confirm">Confirm</option></select></label>
      <p className="field-helper">Confirm requires a preview and short-lived confirmation for destructive operations. None allows granted operations without that extra step.</p>
      <button className="btn primary" disabled={!name.trim()}>{connection ? "Save Connection" : "Create Connection"}</button>
    </fieldset>
  </form>;
}
