import { useEffect, useState } from "react";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import type { AssistantConnectionsView } from "../assistant-connections.js";
import { useInstanceScope } from "../instance-scope.js";
import { AssistantConnectionsDialog } from "./AssistantConnectionsPanel.js";
import { LinkRow, SettingsGroup, StaticRow } from "./ui/SettingsRows.js";

const lastUsed = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function AssistantConnectionsGroup() {
  return <ConnectionsGroup key={useInstanceScope()} />;
}

function ConnectionsGroup() {
  const api = useApi();
  const [view, setView] = useState<AssistantConnectionsView | null>(null);
  const [dialog, setDialog] = useState<"all" | "new" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let current = true;
    void api.assistantConnections().then((response) => {
      if (current) {
        setView(response);
        setError(null);
      }
    }, (cause: unknown) => {
      if (!current) return;
      if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) setUnavailable(true);
      else setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { current = false; };
  }, [api, attempt]);

  if (unavailable) return null;
  return <>
    <SettingsGroup title="Assistant Connections" scope="This Server" className="assistant-connections-group"
      action={view && <button type="button" className="btn" aria-haspopup="dialog" onClick={() => setDialog("new")}>New Connection</button>}
      failure={error ? {
        message: "Couldn't load connections.", detail: error, onRetry: () => setAttempt((count) => count + 1),
      } : null}>
      {view && <>
        {view.connections.slice(0, 3).map((connection) => <StaticRow key={connection.id} title={connection.name}
          description={<>
            {connection.revoked ? "Revoked" : "Active"} · {connection.grant.operations === "all" ? "Full Access" : "Configured Access"}
            <br />
            {connection.lastUsedAt === undefined ? "Last use unavailable"
              : connection.lastUsedAt === null ? "Never used"
                : <>Last used <time dateTime={new Date(connection.lastUsedAt).toISOString()}>{lastUsed.format(connection.lastUsedAt)}</time></>}
          </>} />)}
        <LinkRow title="All Connections" trailing={String(view.connections.length)} hasPopup="dialog" onClick={() => setDialog("all")} />
      </>}
    </SettingsGroup>
    {dialog && <AssistantConnectionsDialog create={dialog === "new"} onClose={() => {
      setDialog(null);
      setAttempt((count) => count + 1);
    }} />}
  </>;
}
