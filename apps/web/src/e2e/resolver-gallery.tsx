import type { AgentQuestion, GovernanceAuditEntry, PermissionResolver, SessionEvent, SessionEventPayload } from "@wollipog/protocol";
import { EventTimeline } from "../components/EventTimeline.js";
import { GovernancePolicyNamesContext } from "../decision-record.js";
import { governanceDecisions } from "../governance.js";
import { ViewerIdentityContext, viewerIdentity } from "../resolver-identity.js";
import { deriveTimeline, type TimelineItem } from "../timeline.js";

/**
 * Who answered a question or decided a governance request, as the viewer Ada Lovelace reads a
 * session she shares with Grace Hopper (#2527): her own answer, Grace's, and one by a member the
 * directory cannot name. Then who resolved a permission (#2628): Ada, Grace, the Allow Reads
 * policy, and a resolution an older runner recorded without naming anyone. `?viewer=solo` reads
 * the same rows as the only member of a personal installation.
 */
const base = Date.UTC(2026, 9, 3, 7, 30, 0);
const scope = { organizationId: "org", sessionId: "gallery", runnerId: "runner" };
const ADA = "user-ada";
const GRACE = "user-grace";
const DEPARTED = "user-departed";

const destination: AgentQuestion = {
  id: "destination",
  header: "Destination",
  question: "Where should this release deploy first?",
  options: [{ label: "Destination 1 (Production)" }, { label: "Destination 2 (Staging)" }],
};
const checks: AgentQuestion = {
  id: "checks",
  header: "Checks",
  question: "Which checks should run before the release is promoted?",
  multiSelect: true,
  options: [{ label: "Unit Tests" }, { label: "Browser Tests" }, { label: "Smoke Test" }],
};
const releaseWindow: AgentQuestion = {
  id: "window",
  header: "Release Window",
  question: "When should the release go out?",
  options: [{ label: "Tonight" }, { label: "Monday Morning" }],
};

const events: SessionEvent[] = [];
const audit: GovernanceAuditEntry[] = [];
const at = (minute: number) => base + minute * 60_000;
function add(payload: SessionEventPayload, minute: number): void {
  events.push({ id: events.length + 1, sessionId: "gallery", seq: events.length + 1, ts: at(minute), payload });
}
function answered(requestId: string, question: AgentQuestion, selected: string, actorId: string, minute: number): void {
  add({ kind: "question_request", requestId, questions: [question] }, minute);
  add({
    kind: "question_resolved", requestId, answered: true, resolutionReason: "submitted",
    answers: [{ questionId: question.id, selected: [selected] }], answeredByUserId: actorId,
  }, minute + 1);
}
function decided(requestId: string, outcome: "allowed" | "denied", actorId: string, minute: number): void {
  audit.push({
    auditId: `decision-${requestId}`, requestId, approvalKind: "policy_hook", stage: "resolution", outcome,
    actor: { kind: "human", id: actorId }, scope, timestamp: at(minute),
  });
}

function permission(requestId: string, title: string, optionId: "approved" | "abort", input: string, minute: number, resolvedBy?: PermissionResolver): void {
  add({
    kind: "permission_request", requestId, title,
    options: [
      { optionId: "approved", name: "Allow Once", kind: "allow_once" },
      { optionId: "abort", name: "Reject", kind: "reject_once" },
    ],
    context: { toolName: "Bash", input, path: "/workspace/release", branch: "release/v0.31.0" },
  }, minute);
  add({ kind: "permission_resolved", requestId, optionId, resolutionReason: "submitted", ...(resolvedBy ? { resolvedBy } : {}) }, minute + 1);
}

answered("by-viewer", destination, "Destination 2 (Staging)", ADA, 0);
answered("by-member", checks, "Smoke Test", GRACE, 2);
answered("by-unknown", releaseWindow, "Monday Morning", DEPARTED, 4);
decided("hook-viewer", "allowed", ADA, 6);
decided("hook-member", "denied", GRACE, 7);
decided("hook-unknown", "allowed", DEPARTED, 8);
permission("permission-viewer", "Run the Release Checks", "approved", "pnpm test", 10, { kind: "user", userId: ADA });
permission("permission-member", "Delete the Staging Database", "abort", "dropdb staging", 12, { kind: "user", userId: GRACE });
permission("permission-policy", "Read the Deploy Config", "approved", "cat deploy/config.yaml", 14, { kind: "policy", policyId: "allow-reads" });
permission("permission-older-peer", "Restart the Preview Server", "approved", "pnpm preview --restart", 16);

const items: TimelineItem[] = [
  ...deriveTimeline(events),
  ...governanceDecisions(audit).map((decision, index): TimelineItem => ({
    kind: "governance_decision", id: -1 - index, decision,
  })),
];

const sharedViewer = viewerIdentity({
  context: {
    userId: ADA, userName: "Ada Lovelace", organizationId: "org", organizationName: "Release Team",
    role: "operator", deviceId: "device-ada", localBootstrap: false,
  },
  organizations: [],
  memberships: [
    { organizationId: "org", organizationName: "Release Team", userId: ADA, userName: "Ada Lovelace", userStatus: "active", role: "operator", createdAt: 1 },
    { organizationId: "org", organizationName: "Release Team", userId: GRACE, userName: "Grace Hopper", userStatus: "active", role: "admin", createdAt: 1 },
  ],
  teams: [],
});
const soloViewer = viewerIdentity({
  context: {
    userId: "user-local", userName: "Local owner", organizationId: "org", organizationName: "Personal organization",
    role: "owner", deviceId: null, localBootstrap: true,
  },
  organizations: [],
  memberships: [
    { organizationId: "org", organizationName: "Personal organization", userId: "user-local", userName: "Local owner", userStatus: "active", role: "owner", createdAt: 1 },
  ],
  teams: [],
});

const policies = { names: new Map([["allow-reads", "Allow Reads"]]), load: () => {}, invalidate: () => {} };

/**
 * Sign-in cards as the runner records them (#2742): the member who chose Recheck, Start Sign-In,
 * Use Current Account, Dismiss Recovery or another account (#2783) is named on the session where
 * they acted. A session the
 * same recovery completed automatically, and a resolution from an older peer, name nobody.
 */
const signInEvents: SessionEvent[] = [];
function signIn(requestId: string, optionId: string, minute: number, resolvedBy?: PermissionResolver): void {
  signInEvents.push({
    id: signInEvents.length + 1, sessionId: "gallery", seq: signInEvents.length + 1, ts: at(minute),
    payload: {
      kind: "permission_request", requestId, title: "Sign In to Claude Code", purpose: "authentication",
      options: [
        { optionId: "auth:accept-current", name: "Use Current Account", kind: "allow_once" },
        { optionId: "auth:login", name: "Start Sign-In", kind: "allow_once" },
        { optionId: "auth:revalidate", name: "Recheck Authentication", kind: "allow_once" },
        { optionId: "auth:dismiss", name: "Dismiss Recovery", kind: "reject_once" },
      ],
    },
  });
  signInEvents.push({
    id: signInEvents.length + 1, sessionId: "gallery", seq: signInEvents.length + 1, ts: at(minute + 1),
    payload: { kind: "permission_resolved", requestId, optionId, ...(resolvedBy ? { resolvedBy } : {}) },
  });
}
signIn("provider-auth:recheck", "auth:revalidate", 20, { kind: "user", userId: ADA });
signIn("provider-auth:login", "auth:login", 22, { kind: "user", userId: GRACE });
signIn("provider-auth:accept", "auth:accept-current", 24, { kind: "user", userId: DEPARTED });
signIn("provider-auth:dismiss", "auth:dismiss", 26, { kind: "user", userId: GRACE });
// Choose Another Account… names the member who chose it (#2783).
signIn("provider-auth:select", "auth:select-account", 27, { kind: "user", userId: ADA });
signIn("provider-auth:automatic", "auth:automatic-retry", 28);
signIn("provider-auth:older-peer", "auth:revalidate", 30);
const signInItems = deriveTimeline(signInEvents);

export function SignInResolverGallery({ solo = false }: { solo?: boolean }) {
  return (
    <ViewerIdentityContext.Provider value={solo ? soloViewer : sharedViewer}>
      <EventTimeline ariaLabel="Sign-In Resolver Rows" items={signInItems} />
    </ViewerIdentityContext.Provider>
  );
}

export function ResolverGallery({ solo = false }: { solo?: boolean }) {
  return (
    <GovernancePolicyNamesContext.Provider value={policies}>
      <ViewerIdentityContext.Provider value={solo ? soloViewer : sharedViewer}>
        <EventTimeline ariaLabel="Resolver Rows" items={items} />
      </ViewerIdentityContext.Provider>
    </GovernancePolicyNamesContext.Provider>
  );
}
