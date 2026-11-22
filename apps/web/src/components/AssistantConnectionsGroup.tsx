import { useEffect, useState } from "react";
import { ApiError } from "../api.js";
import { useApi } from "../api-context.js";
import {
  assistantConnectionAccessSummary, formatAssistantConnectionLastUsed, type AssistantConnectionsView,
} from "../assistant-connections.js";
import { useInstanceScope } from "../instance-scope.js";
import { assistantConnectionsView, type View } from "../navigation.js";
import { AssistantConnectionStatusBadge } from "./AssistantConnectionStatusBadge.js";
import { LinkRow, SettingsGroup } from "./ui/SettingsRows.js";

type ConnectionsGroupProps = { onNavigate(view: View): void };

export function AssistantConnectionsGroup(props: ConnectionsGroupProps) {
  return <ConnectionsGroup key={useInstanceScope()} {...props} />;
}

function ConnectionsGroup({ onNavigate }: ConnectionsGroupProps) {
  const api = useApi();
  const [view, setView] = useState<AssistantConnectionsView | null>(null);
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
  return (
    <SettingsGroup title="Assistant Connections" scope="This Server" className="assistant-connections-group"
      action={view && <button type="button" className="btn" onClick={() => onNavigate(assistantConnectionsView({ kind: "new" }))}>New Connection</button>}
      failure={error ? {
        message: "Couldn't load connections.", detail: error, onRetry: () => setAttempt((count) => count + 1),
      } : null}>
      {view && <>
        {view.connections.slice(0, 3).map((connection) => <LinkRow key={connection.id} title={connection.name} className="assistant-connection-row"
          badge={<AssistantConnectionStatusBadge connection={connection} />}
          description={<>
            {assistantConnectionAccessSummary(connection.grant)}
            <br />
            {connection.lastUsedAt == null
              ? formatAssistantConnectionLastUsed(connection.lastUsedAt)
              : <time dateTime={new Date(connection.lastUsedAt).toISOString()}>
                {formatAssistantConnectionLastUsed(connection.lastUsedAt)}
              </time>}
          </>} onClick={() => onNavigate(assistantConnectionsView({ kind: "detail", id: connection.id }))} />)}
        <LinkRow title="All Connections" trailing={String(view.connections.length)} onClick={() => onNavigate(assistantConnectionsView())} />
      </>}
    </SettingsGroup>
  );
}
