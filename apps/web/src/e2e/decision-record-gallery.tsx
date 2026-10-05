import React from "react";
import type { GovernanceAuditEntry, PermissionOption, SessionEvent, SessionEventPayload, SessionView } from "@wollipog/protocol";
import { EventTimeline } from "../components/EventTimeline.js";
import { GovernancePolicyNamesContext } from "../decision-record.js";
import { governanceDecisions } from "../governance.js";
import { ViewerIdentityContext, viewerIdentity } from "../resolver-identity.js";
import { StoreProvider } from "../store.js";
import { deriveTimeline, type TimelineItem } from "../timeline.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";

/**
 * Every kind of Decision Record (#2204) as the transcript shows it: a permission allowed by you, one
 * rejected, one allowed by a parent session, a tool blocked by a policy, a policy ask that timed
 * out, and a fail-closed block. The parent session's title comes from the app's store, which this
 * page fills with one snapshot, as a live connection would.
 */
const base = Date.now() - 12 * 60_000;
const at = (minute: number) => base + minute * 60_000;
const PARENT = "session-release-orchestrator";

const options: PermissionOption[] = [
  { optionId: "approved", name: "Allow Once", kind: "allow_once" },
  { optionId: "approved_for_session", name: "Allow for Session", kind: "allow_always" },
  { optionId: "abort", name: "Reject", kind: "reject_once" },
];

const events: SessionEvent[] = [];
function add(payload: SessionEventPayload, minute: number): void {
  events.push({ id: events.length + 1, sessionId: "gallery", seq: events.length + 1, ts: at(minute), payload });
}
function permission(requestId: string, title: string, optionId: string, minute: number, extra: Partial<Extract<SessionEventPayload, { kind: "permission_resolved" }>> = {}, input = "pnpm test --filter web"): void {
  add({
    kind: "permission_request", requestId, title, options,
    context: { toolName: "Bash", input, path: "/workspace/wollipog", branch: "agent/decision-records" },
  }, minute);
  add({ kind: "permission_resolved", requestId, optionId, resolutionReason: "submitted", ...extra }, minute + 1);
}

permission("perm-allowed", "Run the Web Unit Tests", "approved", 0);
permission("perm-rejected", "Delete the Build Cache", "abort", 2, {}, "rm -rf apps/web/dist node_modules/.vite");
permission("perm-parent", "Push the Release Branch", "approved", 4, { resolvedByParentSessionId: PARENT }, "git push origin release/v0.31.0");

const scope = { organizationId: "org", sessionId: "gallery", runnerId: "runner", toolName: "Bash", path: "/workspace/wollipog", branch: "main" };
const audit: GovernanceAuditEntry[] = [
  {
    auditId: "audit-blocked", requestId: "hook-blocked", approvalKind: "policy_hook", stage: "policy_decision", outcome: "denied",
    actor: { kind: "policy", id: "no-shell-in-production" }, governancePolicyId: "no-shell-in-production", scope, timestamp: at(7),
  },
  {
    auditId: "audit-timeout", requestId: "hook-timeout", approvalKind: "policy_hook", stage: "resolution", outcome: "timed_out",
    actor: { kind: "system", id: "policy-ask-timeout" }, governancePolicyId: "ask-before-deploys", scope: { ...scope, toolName: "Deploy" }, timestamp: at(9),
  },
  {
    auditId: "audit-fail-closed", requestId: "hook-fail-closed", approvalKind: "policy_hook", stage: "resolution", outcome: "denied",
    actor: { kind: "system", id: "decision-history-unavailable" }, scope: { ...scope, toolName: "Write" }, timestamp: at(10),
  },
];

const items: TimelineItem[] = [
  ...deriveTimeline(events),
  ...governanceDecisions(audit).map((decision, index): TimelineItem => ({ kind: "governance_decision", id: 100 + index, decision })),
];

const policies = {
  names: new Map([["no-shell-in-production", "No Shell in Production"], ["ask-before-deploys", "Ask Before Deploys"]]),
  load: () => {},
};

/** Alice is the only member, so her decisions read "by You". */
const viewer = viewerIdentity({
  context: {
    userId: "alice", userName: "Alice", organizationId: "org", organizationName: "Personal organization",
    role: "owner", deviceId: null, localBootstrap: true,
  },
  organizations: [],
  memberships: [],
  teams: [],
});

const parentSession = {
  id: PARENT, runnerId: "runner", workspaceId: null, workspaceName: null, projectId: null,
  agentId: "codex", agentName: "Codex", title: "Release Orchestrator", status: "running",
  column: "review", runId: null, useWorktree: false, worktreePath: null,
  archived: false, createdAt: base, updatedAt: base, lastEventAt: null, messageCount: 0,
  eventEpoch: 0, preview: null, pendingApproval: null, driver: "codex-app-server",
  model: null, effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
} as SessionView;

/** A connection whose first frame is a snapshot holding the parent session. */
const connection: UiConnectionRuntime = {
  instanceId: "decision-records", runtimeKey: "decision-records",
  onCredentialChange: () => () => {},
  createSocket: () => {
    const socket: UiSocket = { readyState: UI_SOCKET_OPEN, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} };
    setTimeout(() => socket.onmessage?.({
      data: JSON.stringify({ type: "snapshot", runners: [], boxes: [], sessions: [parentSession], runs: [], pods: [] }),
    }), 0);
    return socket;
  },
  close() {},
};

export function DecisionRecordGallery() {
  return (
    <StoreProvider connection={connection}>
      <GovernancePolicyNamesContext.Provider value={policies}>
        <ViewerIdentityContext.Provider value={viewer}>
          <EventTimeline ariaLabel="Decision Records" items={items} onOpenSession={() => {}} />
        </ViewerIdentityContext.Provider>
      </GovernancePolicyNamesContext.Provider>
    </StoreProvider>
  );
}
