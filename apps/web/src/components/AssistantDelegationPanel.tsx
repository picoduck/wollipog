import { useEffect, useState } from "react";
import { useApi } from "../api-context.js";
import { formatAssistantDelegationSummary } from "../assistant-decision-delegation.js";
import { assistantThreadTitle, assistantThreadsOwnerOnly, assistantThreadsUnavailable, type AssistantThread } from "../assistant-threads.js";
import { useInstanceScope } from "../instance-scope.js";
import { useTimelineClock } from "../timeline-clock.js";
import { useFeedback } from "./FeedbackProvider.js";
import { Notice } from "./Notice.js";
import { StatusBadge } from "./StatusBadge.js";
import { ActionRow, SettingsGroup, StaticRow } from "./ui/SettingsRows.js";

export function AssistantDelegationPanel() {
  return <DelegationGroup key={useInstanceScope()} />;
}

type Grants = { kind: "loading" | "unavailable" | "ownerOnly" }
  | { kind: "ready"; threads: AssistantThread[] }
  | { kind: "failed"; message: string };

function DelegationGroup() {
  const api = useApi();
  const { confirm } = useFeedback();
  const [grants, setGrants] = useState<Grants>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const threads = grants.kind === "ready" ? grants.threads : [];
  const now = useTimelineClock(threads.some((thread) => thread.decisionDelegation?.grant?.expiresAt != null));

  useEffect(() => {
    let current = true;
    void api.assistantThreads().then(({ threads }) => {
      if (current) setGrants({ kind: "ready", threads: threads.filter((thread) => thread.status !== "archived" && thread.decisionDelegation?.grant) });
    }, (cause: unknown) => {
      if (!current) return;
      if (assistantThreadsOwnerOnly(cause)) setGrants({ kind: "ownerOnly" });
      else if (assistantThreadsUnavailable(cause)) setGrants({ kind: "unavailable" });
      else setGrants({ kind: "failed", message: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { current = false; };
  }, [api, attempt]);

  if (grants.kind === "ownerOnly") return null;
  const clear = async (thread: AssistantThread, expired: boolean) => {
    if (!thread.decisionDelegation?.grant || removing) return;
    const revision = thread.decisionDelegation.revision;
    const remove = async () => {
      await api.setAssistantThreadDelegation(thread.id, { revision, grant: null });
      setGrants((current) => current.kind === "ready"
        ? { kind: "ready", threads: current.threads.filter((item) => item.id !== thread.id) } : current);
    };
    if (!expired) {
      await confirm({
        title: "Revoke Delegation",
        message: `“${assistantThreadTitle(thread)}” will lose permission to resolve decisions on your behalf.`,
        confirmLabel: "Revoke Delegation",
        tone: "danger",
        progress: "Revoking delegation…",
        cancelWhileRunning: false,
        onConfirm: remove,
      });
      return;
    }
    setRemoving(thread.id);
    setRemoveError(null);
    try {
      await remove();
    } catch (cause) {
      setRemoveError(cause instanceof Error ? cause.message : String(cause));
      setAttempt((count) => count + 1);
    } finally {
      setRemoving(null);
    }
  };
  return <SettingsGroup title="Active Delegations" scope="Your Account"
    notice={removeError && <Notice role="alert" tone="danger">{removeError}</Notice>}
    failure={grants.kind === "failed" ? {
      message: "Couldn't load delegation grants.", detail: grants.message,
      onRetry: () => { setGrants({ kind: "loading" }); setAttempt((count) => count + 1); },
    } : null}
  >
    {grants.kind === "loading" && <StaticRow title="Decision Grants" description={<span role="status">Loading grants…</span>} />}
    {grants.kind === "unavailable" && <StaticRow title="Decision Grants" description="This control plane does not report thread grants." />}
    {grants.kind === "ready" && threads.length === 0
      && <StaticRow title="No Delegation Grants" description="Open a thread's settings to grant access." />}
    {threads.map((thread) => {
      const grant = thread.decisionDelegation?.grant;
      const expired = grant?.expiresAt != null && grant.expiresAt <= now;
      return <ActionRow key={thread.id} title={assistantThreadTitle(thread)}
        badge={<StatusBadge noDot size="md" tone={expired ? "neutral" : "success"} label={expired ? "Expired" : "Active"} />}
        description={formatAssistantDelegationSummary(grant, now)}
        actionLabel={expired ? "Remove" : "Revoke…"} hasPopup={expired ? undefined : "dialog"}
        disabled={removing !== null} onAction={() => void clear(thread, expired)} />;
    })}
  </SettingsGroup>;
}
