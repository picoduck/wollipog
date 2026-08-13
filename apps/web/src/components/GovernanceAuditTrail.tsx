import React, { useEffect, useState } from "react";
import type { GovernanceAuditEntry } from "@wollipog/protocol";
import { useApi } from "../api-context.js";

type VisibleOutcome = {
  label: string;
  detail: string;
  tone: "allowed" | "denied" | "timed-out" | "policy";
};

type VisibleAuditOutcome = {
  entry: GovernanceAuditEntry;
  outcome: VisibleOutcome;
};

export function governanceAuditPresentation(entry: GovernanceAuditEntry): VisibleOutcome | null {
  if (entry.approvalKind !== "policy_hook") return null;
  if (entry.stage === "policy_decision" && entry.outcome === "denied") {
    return { label: "Blocked by Policy", detail: "The matched policy denied this tool.", tone: "policy" };
  }
  if (entry.stage !== "resolution") return null;
  if (entry.outcome === "timed_out") {
    return { label: "Approval Timed Out", detail: "The policy deadline expired, so the tool was denied.", tone: "timed-out" };
  }
  if (entry.actor.kind === "human" && entry.outcome === "allowed") {
    return { label: "Approved by You", detail: "The suspended tool invocation resumed.", tone: "allowed" };
  }
  if (entry.actor.kind === "human" && entry.outcome === "denied") {
    return { label: "Denied by You", detail: "The suspended tool invocation was blocked.", tone: "denied" };
  }
  return null;
}

export function visibleGovernanceAuditOutcomes(entries: GovernanceAuditEntry[]): VisibleAuditOutcome[] {
  return entries
    .map((entry) => ({ entry, outcome: governanceAuditPresentation(entry) }))
    .filter((item): item is VisibleAuditOutcome => item.outcome != null)
    .slice(0, 4);
}

export function GovernanceAuditOutcomes({ entries }: { entries: GovernanceAuditEntry[] }) {
  const visible = visibleGovernanceAuditOutcomes(entries);
  if (!visible.length) return null;

  return (
    <section className="governance-audit-trail" aria-label="Governance Decisions">
      <div className="governance-audit-heading">Governance Decisions</div>
      {visible.map(({ entry, outcome }) => (
        <div
          className={`governance-audit-outcome ${outcome.tone}`}
          data-audit-id={entry.auditId}
          key={entry.auditId}
        >
          <strong>{outcome.label}</strong>
          <span>{outcome.detail}</span>
        </div>
      ))}
    </section>
  );
}

export function GovernanceAuditTrail({
  sessionId,
  revision,
}: {
  sessionId: string;
  revision: string;
}) {
  const api = useApi();
  const [entries, setEntries] = useState<GovernanceAuditEntry[]>([]);

  useEffect(() => {
    let active = true;
    void api.governanceAudit(sessionId, 50)
      .then((response) => {
        if (active) setEntries(response.entries);
      })
      .catch(() => {
        if (active) setEntries([]);
      });
    return () => {
      active = false;
    };
  }, [api, revision, sessionId]);

  return <GovernanceAuditOutcomes entries={entries} />;
}
