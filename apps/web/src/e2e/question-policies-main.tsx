import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { GovernancePolicy } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { QuestionPoliciesPanel } from "../components/QuestionPoliciesPanel.js";
import { GovernanceHistoryPanel } from "../components/GovernanceHistoryPanel.js";
import { governanceDecisions } from "../governance.js";
import { EventTimeline } from "../components/EventTimeline.js";
import { ViewerIdentityContext, viewerIdentity } from "../resolver-identity.js";
import { GovernancePolicyNamesContext } from "../decision-record.js";
import { DecisionRecordGallery } from "./decision-record-gallery.js";
import "../styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";
const client: ApiClient = {
  ...api,
  governancePolicies: async () => ({ policies: JSON.parse(sessionStorage.getItem("question-policies") ?? "[]") }),
  getIdentity: async () => ({ context: { userId: "alice", organizationId: "org" } }) as never,
  putGovernancePolicy: async (policy) => {
    if (params.has("failure")) throw new Error("The policy could not be saved.");
    const saved = { ...policy, createdAt: 1, updatedAt: 2 };
    const old: GovernancePolicy[] = JSON.parse(sessionStorage.getItem("question-policies") ?? "[]");
    sessionStorage.setItem("question-policies", JSON.stringify([...old.filter((p) => p.policyId !== saved.policyId), saved]));
    return saved;
  },
};
const now = Date.now();
const hookDecisions = governanceDecisions([{
  auditId: "older-human-approval", requestId: "policy-hook-transport:0", approvalKind: "policy_hook",
  stage: "resolution", outcome: "allowed", actor: { kind: "human", id: "alice" },
  scope: { organizationId: "org", sessionId: "example", runnerId: "runner" }, timestamp: now - 120_000,
}, {
  auditId: "hook-audit", requestId: "policy-hook-transport:1", approvalKind: "policy_hook",
  stage: "policy_decision", outcome: "denied", actor: { kind: "policy", id: "deny-shell" },
  governancePolicyId: "deny-shell",
  scope: { organizationId: "org", sessionId: "example", runnerId: "runner" }, timestamp: now - 60_000,
}]);

/** Alice is the only member, so her own approval reads "Approved by You". */
const soloViewer = viewerIdentity({
  context: {
    userId: "alice", userName: "Alice", organizationId: "org", organizationName: "Personal organization",
    role: "owner", deviceId: null, localBootstrap: true,
  },
  organizations: [],
  memberships: [],
  teams: [],
});

function GovernanceFixture() {
  const [olderLoaded, setOlderLoaded] = useState(false);
  const visibleDecisions = olderLoaded ? hookDecisions : hookDecisions.slice(1);
  return <>
    <EventTimeline ariaLabel="Native Governance Event" items={[{
      kind: "tool_call", id: 10, toolCallId: "tool-1", title: "Run Shell Command",
      status: "pending", text: "Awaiting governance approval", startedAt: now - 62_000,
    }, {
      kind: "governance_decision", id: 11, decision: hookDecisions[1]!,
    }]} />
    <h2>Governance History</h2>
    <GovernanceHistoryPanel
      decisions={visibleDecisions}
      hasMore={!olderLoaded}
      onLoadOlder={() => setOlderLoaded(true)}
    />
  </>;
}

/** The policy behind the native decision, named as Settings › Approvals names it. */
const policyNames = { names: new Map([["deny-shell", "Deny Shell Commands"]]), load: () => {}, invalidate: () => {} };

const root = createRoot(document.getElementById("root")!);
if (params.get("set") === "decisions") {
  root.render(<main className="session-detail" style={{ maxWidth: 860, margin: "24px auto", padding: "0 16px" }}>
    <DecisionRecordGallery />
  </main>);
} else root.render(<ApiProvider client={client}>
  <GovernancePolicyNamesContext.Provider value={policyNames}>
  <ViewerIdentityContext.Provider value={soloViewer}>
  <main className="settings-panel" style={{ maxWidth: 760, margin: "24px auto", padding: 20 }}>
    <h2>Behavior</h2><QuestionPoliciesPanel />
    <EventTimeline ariaLabel="Policy Attribution Example" items={[{ kind: "question", id: 1, requestId: "review", answered: true,
      answeredByPolicies: ["Review Sharing and Retries"], answers: [{ questionId: "q", selected: ["Proceed"] }],
      questions: [{ id: "q", question: "May I send this diff for review?", options: [{ label: "Proceed" }] }],
    }, {
      kind: "governance_decision", id: -1, decision: hookDecisions[0]!,
    }]} />
    <GovernanceFixture />
  </main>
  </ViewerIdentityContext.Provider>
  </GovernancePolicyNamesContext.Provider>
</ApiProvider>);
