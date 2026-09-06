import React from "react";
import { createRoot } from "react-dom/client";
import type { GovernancePolicy } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { QuestionPoliciesPanel } from "../components/QuestionPoliciesPanel.js";
import { GovernanceAuditOutcomes } from "../components/GovernanceAuditTrail.js";
import { EventTimeline } from "../components/EventTimeline.js";
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
createRoot(document.getElementById("root")!).render(<ApiProvider client={client}>
  <main className="settings-panel" style={{ maxWidth: 760, margin: "24px auto", padding: 20 }}>
    <h2>Behavior</h2><QuestionPoliciesPanel />
    <EventTimeline items={[{ kind: "question", id: 1, requestId: "review", answered: true,
      answeredByPolicies: ["Review Sharing and Retries"],
      questions: [{ id: "q", question: "May I send this diff for review?", options: [{ label: "Proceed" }] }],
    }]} />
    <GovernanceAuditOutcomes entries={[{
      auditId: "policy-audit", requestId: "review", approvalKind: "question", stage: "policy_decision", outcome: "answered",
      actor: { kind: "policy", id: "questions:review:alice" }, governancePolicyId: "questions:review:alice",
      scope: { organizationId: "org", sessionId: "example", runnerId: "runner" }, timestamp: 1,
    }]} />
  </main>
</ApiProvider>);
