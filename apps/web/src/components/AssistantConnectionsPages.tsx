import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApi } from "../api-context.js";
import {
  assistantConnectionAccessSummary, formatAssistantConnectionLastUsed,
  type AssistantConnection, type AssistantConnectionsView,
} from "../assistant-connections.js";
import { useInstanceScope } from "../instance-scope.js";
import { assistantConnectionsView, type AssistantConnectionsRoute, type View } from "../navigation.js";
import { AssistantConnectionActivity } from "./AssistantConnectionActivity.js";
import { AssistantConnectionEditor } from "./AssistantConnectionEditor.js";
import { AssistantConnectionStatusBadge } from "./AssistantConnectionStatusBadge.js";
import { AssistantCredentialDialog, RenameAssistantInstallationDialog } from "./AssistantConnectionDialogs.js";
import { CopyButton } from "./common.js";
import { useFeedback } from "./FeedbackProvider.js";
import { PlusIcon, ResetIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { DetailBar, type ActionsMenuChoice } from "./PageHeader.js";
import { State } from "./State.js";
import { LinkRow, SettingsGroup, StaticRow, ValueRow } from "./ui/SettingsRows.js";

type Navigate = (view: View, options?: { replace?: boolean }) => void;

export function AssistantConnectionsPages({ route, onNavigate }: { route: AssistantConnectionsRoute; onNavigate: Navigate }) {
  const scope = useInstanceScope();
  // The credential belongs to this visit and instance. Unmounting drops it and prevents late
  // writes from reopening the one-time step or navigating away from the incoming page.
  const key = JSON.stringify([scope, route.kind, route.kind === "detail" ? route.id : null]);
  return <ConnectionPage key={key} route={route} onNavigate={onNavigate} />;
}

function ConnectionPage({ route, onNavigate }: { route: AssistantConnectionsRoute; onNavigate: Navigate }) {
  const api = useApi();
  const { confirm } = useFeedback();
  const root = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const pendingWrite = useRef(false);
  const [data, setData] = useState<AssistantConnectionsView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [credential, setCredential] = useState<{ token: string; newConnectionId?: string } | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    const scroller = root.current?.closest(".main-body");
    if (scroller) scroller.scrollTop = 0;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void api.assistantConnections().then(view => {
      if (!cancelled) setData(view);
    }, cause => {
      if (!cancelled) setLoadError(cause instanceof Error ? cause.message : "Couldn't load Assistant Connections.");
    });
    return () => { cancelled = true; };
  }, [api, loadAttempt]);

  const runWrite = async (action: () => Promise<void>, reportError: (message: string) => void = setError) => {
    if (pendingWrite.current) return;
    pendingWrite.current = true;
    setBusy(true);
    reportError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      if (mounted.current) {
        const message = cause instanceof Error ? cause.message : "Couldn't reach Wollipog.";
        reportError(message + " If a change may have been delivered, refresh and inspect the connection before trying it again.");
      }
    } finally {
      pendingWrite.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const connection = route.kind === "detail" ? data?.connections.find(item => item.id === route.id) : undefined;
  const update = (updated: AssistantConnection) => setData(current => current && ({
    ...current,
    connections: current.connections.map(item => item.id === updated.id ? { ...item, ...updated } : item),
  }));
  const openList = () => onNavigate(assistantConnectionsView());
  const openConnection = (id: string, replace = false) => onNavigate(assistantConnectionsView({ kind: "detail", id }), { replace });

  const changeCredential = (action: "rotate" | "revoke", choice?: ActionsMenuChoice) => void runWrite(async () => {
    if (!connection) return;
    const title = action === "rotate" ? "Rotate Credential" : "Revoke Connection";
    const approved = await confirm({
      title, confirmLabel: title, tone: "danger",
      message: action === "rotate"
        ? `The old credential for “${connection.name}” stops working immediately. Update the assistant with the new credential shown once after rotation.`
        : `Permanently disable “${connection.name}”. Already completed actions are retained. Create a new connection to restore access.`,
      back: choice && { label: "Back to More Actions", run: choice.reopen },
    });
    if (!approved || !mounted.current) return;
    if (action === "rotate") {
      const result = await api.rotateAssistantConnection(connection.id);
      if (!mounted.current) return;
      update(result.connection);
      setCredential({ token: result.token });
    } else {
      const result = await api.revokeAssistantConnection(connection.id);
      if (!mounted.current) return;
      update(result.connection);
      setNotice("Connection revoked.");
    }
  });

  const closeCredential = () => {
    setCredential(null);
    if (credential?.newConnectionId) openConnection(credential.newConnectionId, true);
  };

  return (
    <div ref={root} className={route.kind === "list" ? "page assistant-connections-page assistant-connections-list" : "page assistant-connections-page"}>
      <DetailBar
        title={route.kind === "list" ? "Assistant Connections" : route.kind === "new" ? "New Connection" : connection?.name ?? "Assistant Connection"}
        backLabel={route.kind === "list" ? "Back to Assistant Settings" : "Back to Assistant Connections"}
        onBack={route.kind === "list" ? () => onNavigate({ name: "settings", section: "assistant" }) : openList}
        status={connection && <AssistantConnectionStatusBadge connection={connection} />}
        searchInMenu={route.kind === "detail"}
        primary={route.kind === "list" && data ? {
          label: "New Connection", iconOnPhone: true, icon: <PlusIcon />,
          onClick: () => onNavigate(assistantConnectionsView({ kind: "new" })),
        } : undefined}
        secondary={connection && !connection.revoked && !connection.threadId ? {
          label: "Rotate Credential…", icon: <ResetIcon />, iconOnPhone: true, disabled: busy,
          onClick: () => changeCredential("rotate"),
        } : undefined}
        menu={connection && !connection.revoked ? [{
          label: "Revoke Connection…", danger: true, disabled: busy,
          onClick: choice => changeCredential("revoke", choice),
        }] : undefined}
      />
      <div className="assistant-connections-content form">
        {error && <Notice tone="danger" role="alert">{error}</Notice>}
        {notice && <Notice tone="success" role="status">{notice}</Notice>}
        {!data && (loadError
          ? <State variant="error" actions={<button className="btn sm" type="button" onClick={() => {
            setLoadError("");
            setLoadAttempt(attempt => attempt + 1);
          }}>Try Again</button>}>{loadError}</State>
          : <State variant="loading">Loading connections…</State>)}
        {data && route.kind === "list" && <>
          <SettingsGroup title="Installation" scope="This Server">
            <div className="setting-row assistant-installation-row">
              <div className="setting-row-label">
                <span className="setting-row-title">{data.installation.name}</span>
                <code className="setting-row-desc">{data.installation.id}</code>
              </div>
              <div className="setting-row-control">
                <CopyButton text={data.installation.id} className="btn" ariaLabel="Copy Installation ID" />
                {data.installation.canRename && (
                  <button className="btn" type="button" aria-haspopup="dialog" onClick={() => setRenaming(true)}>Rename…</button>
                )}
              </div>
            </div>
          </SettingsGroup>
          <SettingsGroup title="Connections">
            {data.connections.length === 0 ? <StaticRow title="No Connections" /> : data.connections.map(item => (
              <LinkRow key={item.id} className="assistant-connection-row" title={item.name}
                badge={<AssistantConnectionStatusBadge connection={item} />}
                description={<>{assistantConnectionAccessSummary(item.grant)} · {formatAssistantConnectionLastUsed(item.lastUsedAt)}</>}
                onClick={() => openConnection(item.id)} />
            ))}
          </SettingsGroup>
          {renaming && <RenameAssistantInstallationDialog initial={data.installation.name} busy={busy} onClose={() => setRenaming(false)}
            onSave={(name, reportError) => void runWrite(async () => {
              const installation = await api.renameAssistantInstallation(name);
              if (!mounted.current) return;
              setData(current => current && ({ ...current, installation: { ...current.installation, ...installation } }));
              setRenaming(false);
              setNotice("Installation name saved.");
            }, reportError)} />}
        </>}
        {data && route.kind === "detail" && !connection && <State variant="error">This connection is unavailable on this server.</State>}
        {data && (route.kind === "new" || connection) && (
          <>
            <AssistantConnectionEditor key={connection?.revision ?? "new"} view={data} connection={connection} busy={busy || Boolean(credential)}
              onSave={(name, grant) => void runWrite(async () => {
                if (connection) {
                  const result = await api.configureAssistantConnection(connection.id, { name, grant, expectedRevision: connection.revision });
                  if (!mounted.current) return;
                  update(result.connection);
                  setNotice("Connection saved.");
                } else {
                  const result = await api.createAssistantConnection({ name, grant });
                  if (mounted.current) setCredential({ token: result.token, newConnectionId: result.connection.id });
                }
              })} />
            {connection && <>
              <AssistantConnectionActivity id={connection.id} />
              <SettingsGroup>
                <ValueRow title="Connection ID" value={connection.id} mono wrap copy />
              </SettingsGroup>
            </>}
          </>
        )}
      </div>
      {credential && <AssistantCredentialDialog token={credential.token} onClose={closeCredential} />}
    </div>
  );
}
