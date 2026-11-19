import { useEffect, useState } from "react";
import type { AssistantThreadLimits } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { assistantThreadsOwnerOnly, assistantThreadsUnavailable } from "../assistant-threads.js";
import { formatUsd } from "../guardrail-values.js";
import { useInstanceScope } from "../instance-scope.js";
import { AssistantThreadLimitsDialog } from "./AssistantThreadLimitsDialog.js";
import { Notice } from "./Notice.js";
import { ActionRow, SettingsGroup } from "./ui/SettingsRows.js";

export function AssistantThreadDefaultsPanel() {
  return <AssistantThreadDefaultsGroup key={useInstanceScope()} />;
}

function AssistantThreadDefaultsGroup() {
  const api = useApi();
  const [limits, setLimits] = useState<AssistantThreadLimits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let current = true;
    void api.assistantThreadLimitDefaults().then((response) => {
      if (current) setLimits(response);
    }, (cause: unknown) => {
      if (current && !assistantThreadsUnavailable(cause) && !assistantThreadsOwnerOnly(cause)) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => { current = false; };
  }, [api, attempt]);

  if (!limits && !error) return null;
  return (
    <SettingsGroup title="Assistant Threads" scope="Your Account">
      {error && <Notice tone="danger" role="alert" title="Couldn't Load Thread Limits"
        actions={<button type="button" className="btn sm" onClick={() => { setError(null); setAttempt(attempt + 1); }}>Retry</button>}>
        {error}
      </Notice>}
      {limits && <>
        <ActionRow
          title="Default Thread Limits"
          description={`${limits.costUsd === null ? "No Budget" : `${formatUsd(limits.costUsd)} budget`} · ${limits.launchedSessions === null
            ? "No Launch Limit"
            : `${limits.launchedSessions} session ${limits.launchedSessions === 1 ? "launch" : "launches"}`}`}
          hasPopup="dialog"
          actionLabel="Edit Limits…"
          onAction={() => setEditing(true)}
        />
        {editing && <AssistantThreadLimitsDialog defaults limits={limits} onClose={() => setEditing(false)}
          onSave={async (next) => setLimits(await api.setAssistantThreadLimitDefaults(next))} />}
      </>}
    </SettingsGroup>
  );
}
