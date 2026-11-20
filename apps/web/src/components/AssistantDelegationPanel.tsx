import { useEffect, useState } from "react";
import { useApi } from "../api-context.js";
import { assistantThreadTitle, assistantThreadsOwnerOnly, assistantThreadsUnavailable, type AssistantThread } from "../assistant-threads.js";
import { useInstanceScope } from "../instance-scope.js";
import { useTimelineClock } from "../timeline-clock.js";
import { LinkRow, SettingsGroup, StaticRow } from "./ui/SettingsRows.js";

const grantDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function AssistantDelegationPanel({ onOpenGrant }: { onOpenGrant: (threadId: string) => void }) {
  return <DelegationGroup key={useInstanceScope()} onOpenGrant={onOpenGrant} />;
}

type Grants = { kind: "loading" | "unavailable" | "ownerOnly" }
  | { kind: "ready"; threads: AssistantThread[] }
  | { kind: "failed"; message: string };

function DelegationGroup({ onOpenGrant }: { onOpenGrant: (threadId: string) => void }) {
  const api = useApi();
  const [grants, setGrants] = useState<Grants>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
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
  return <SettingsGroup title="Delegation" scope="Your Account"
    intro="You can delegate decisions to individual threads, limit each grant's scope, and revoke it at any time."
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
      const expiresAt = thread.decisionDelegation?.grant?.expiresAt;
      const date = expiresAt == null ? null : new Date(expiresAt);
      const status = expiresAt == null ? "Active" : expiresAt <= now ? "Expired" : "Active · Expires";
      return <LinkRow key={thread.id} title={assistantThreadTitle(thread)}
        description={date ? <>{status} <time dateTime={date.toISOString()}>{grantDate.format(date)}</time></> : status}
        onClick={() => onOpenGrant(thread.id)} />;
    })}
  </SettingsGroup>;
}
