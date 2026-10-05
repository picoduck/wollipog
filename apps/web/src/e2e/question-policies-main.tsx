import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { GovernancePolicy } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { ApprovalsPanel } from "../components/ApprovalsPanel.js";
import { SettingsView } from "../components/SettingsView.js";
import { DecisionHistoryPanel } from "../components/DecisionHistoryPanel.js";
import { decisionHistory } from "../governance.js";
import { EventTimeline } from "../components/EventTimeline.js";
import { ViewerIdentityContext, viewerIdentity } from "../resolver-identity.js";
import { GovernancePolicyNamesContext } from "../decision-record.js";
import { DecisionRecordGallery } from "./decision-record-gallery.js";
import type { SettingsSection } from "../navigation.js";
import "../styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") ?? "light";

/**
 * Tool policies the control plane would list beside the stored question policies: the built-in
 * spawn gate and a spread of effects, scopes, conditions and timeouts, deliberately out of order.
 */
const TOOL_POLICIES: GovernancePolicy[] = [
  {
    policyId: "allow-tests", name: "Allow Running the Web Unit Tests", effect: "allow", priority: 10, enabled: true,
    scope: { toolName: "Bash", path: "apps/web" }, createdAt: 1, updatedAt: Date.UTC(2026, 8, 30, 15, 4),
  },
  {
    policyId: "builtin:session-spawn-human-gate", name: "Review Agent-Created Sessions", effect: "ask", priority: -1_000_000,
    enabled: true, builtin: true, scope: { toolName: "wollipog.create_session" }, createdAt: 0, updatedAt: 0,
  },
  {
    policyId: "deny-shell", name: "Deny Shell Commands in Production", effect: "deny", priority: 50, enabled: true,
    scope: { runnerId: "runner-prod", toolName: "Bash", branch: "main" },
    conditions: { escalated: false, minCostUsd: 5 }, createdAt: 1, updatedAt: Date.UTC(2026, 9, 1, 9, 30),
  },
  {
    policyId: "ask-deploys", name: "Ask Before Deploys", effect: "ask", priority: 50, enabled: true,
    scope: { toolName: "deploy" }, askTimeout: 600, createdAt: 1, updatedAt: Date.UTC(2026, 9, 2, 11, 0),
  },
  {
    policyId: "old-network", name: "Block the Staging Network", effect: "deny", priority: 0, enabled: false,
    scope: { network: "staging.internal" }, createdAt: 1, updatedAt: Date.UTC(2026, 7, 12, 8, 0),
  },
];

/** A custom question policy from the command line, and one of someone else's that must not show. */
const CUSTOM_QUESTION_POLICIES: GovernancePolicy[] = [
  {
    policyId: "questions:custom:release-notes:alice", name: "Release Notes Drafts", effect: "allow", priority: 0, enabled: true,
    ownerUserId: "alice", scope: { organizationId: "org" },
    questionRule: { questionPattern: "May I draft the release notes*", answer: { option: "Yes" } }, createdAt: 1, updatedAt: 2,
  },
  {
    policyId: "questions:custom:bob-only:bob", name: "Bob's Own Policy", effect: "allow", priority: 0, enabled: true,
    ownerUserId: "bob", scope: { organizationId: "org" },
    questionRule: { questionPattern: "*", answer: { text: "Yes" } }, createdAt: 1, updatedAt: 2,
  },
];

const STORE = "question-policies";
const stored = (): GovernancePolicy[] => JSON.parse(sessionStorage.getItem(STORE) ?? "[]");
/** Every write the section sends, so a test can assert the tool policies never receive one. */
const writes: string[] = [];
(window as unknown as { governanceWrites: string[] }).governanceWrites = writes;
let loads = 0;

const client: ApiClient = {
  ...api,
  governancePolicies: async () => {
    loads += 1;
    // `load=pending` never settles; `load=fail` fails the first load and lets Retry succeed.
    if (params.get("load") === "pending") return new Promise(() => undefined);
    if (params.get("load") === "fail" && loads === 1) throw new Error("GET /api/governance/policies failed with 502 Bad Gateway");
    const custom = params.has("custom") ? CUSTOM_QUESTION_POLICIES : [];
    const own = stored();
    return { policies: [...TOOL_POLICIES, ...custom.filter((policy) => !own.some((saved) => saved.policyId === policy.policyId)), ...own] };
  },
  getIdentity: async () => ({ context: { userId: "alice", organizationId: "org" } }) as never,
  putGovernancePolicy: async (policy) => {
    writes.push(policy.policyId);
    if (params.has("failure")) throw new Error("The policy could not be saved.");
    const saved = { ...policy, createdAt: 1, updatedAt: 2 };
    sessionStorage.setItem(STORE, JSON.stringify([...stored().filter((p) => p.policyId !== saved.policyId), saved]));
    return saved;
  },
};
const now = Date.now();
const hookDecisions = decisionHistory([{
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
    <h2>Decision History</h2>
    <DecisionHistoryPanel
      decisions={visibleDecisions}
      hasMore={!olderLoaded}
      onLoadOlder={() => setOlderLoaded(true)}
    />
  </>;
}

/** The policy behind the native decision, named as Settings › Approvals names it. */
const policyNames = { names: new Map([["deny-shell", "Deny Shell Commands"]]), load: () => {}, invalidate: () => {} };

/**
 * Settings › Approvals as the shell renders it: the section list beside the panel, under the
 * production `.app > main.main > .main-body` structure. `policy` is the id a policy link targets.
 */
function ApprovalsFixture() {
  const [section, setSection] = useState<SettingsSection>("approvals");
  const empty = { appearance: null, notifications: null, keyboard: null, behavior: null, orchestrator: null, network: null, experimental: null, about: null };
  return (
    <div className="app">
      <main className="main">
        <div className="main-body">
          <SettingsView
            section={section}
            onNavigate={(view) => { if (view.name === "settings" && view.section) setSection(view.section); }}
            onOpenShortcuts={() => undefined}
            panels={{ ...empty, approvals: <ApprovalsPanel policyId={params.get("policy") ?? undefined} /> }}
          />
        </div>
      </main>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
if (params.get("set") === "decisions") {
  root.render(<main className="session-detail" style={{ maxWidth: 860, margin: "24px auto", padding: "0 16px" }}>
    <DecisionRecordGallery />
  </main>);
} else if (params.get("set") === "approvals") {
  root.render(<ApiProvider client={client}><ApprovalsFixture /></ApiProvider>);
} else root.render(<ApiProvider client={client}>
  <GovernancePolicyNamesContext.Provider value={policyNames}>
  <ViewerIdentityContext.Provider value={soloViewer}>
  <main className="settings-panel" style={{ maxWidth: 760, margin: "24px auto", padding: 20 }}>
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
