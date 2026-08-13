import assert from "node:assert/strict";
import test from "node:test";
import type { ControlPlaneToUi, ProjectView, SessionView } from "@wollipog/protocol";
import {
  persistProjectAssignment,
  projectAssignmentAudienceConfirmation,
  projectAudienceVisibilityLabel,
  projectAudienceVisibilitySummary,
  projectAudienceLabel,
  sessionProjectChoices,
  shouldSubmitProjectAssignment,
} from "./session-project-assignment.js";
import { Store } from "./store.js";

function project(id: string, runnerId: string, workspaceId: string): ProjectView {
  return {
    id,
    name: "Same Name",
    hidden: false,
    locations: [{
      id: `location-${id}`,
      projectId: id,
      runnerId,
      workspaceId,
      name: "Workspace",
      path: `/${workspaceId}`,
      source: "managed",
      availability: "available",
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
    }],
    activeSessionCount: 0,
    unarchivedSessionCount: 0,
    totalSessionCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "session-1",
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    projectId: null,
    projectName: null,
    projectLocationId: null,
    agentId: "agent",
    agentName: "Agent",
    title: "Session",
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: 1,
    messageCount: 0,
    preview: null,
    pendingApproval: null,
    driver: "acp",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
    ...overrides,
  };
}

test("Project choices use exact Location identity when display names match", () => {
  const choices = sessionProjectChoices(session(), [
    project("project-other", "runner-2", "workspace-1"),
    project("project-exact", "runner-1", "workspace-1"),
  ]);

  assert.deepEqual(choices.map(({ id, compatible }) => [id, compatible]), [["project-exact", true]]);
});

test("a historical current Project remains visible beside the exact compatible Project", () => {
  const historical = project("project-historical", "runner-1", "old-workspace");
  const exact = project("project-exact", "runner-1", "workspace-1");
  const choices = sessionProjectChoices(session({
    projectId: historical.id,
    projectName: historical.name,
    projectLocationId: "removed-location",
  }), [historical, exact]);

  assert.deepEqual(choices.map(({ id, compatible, current }) => [id, compatible, current]), [
    ["project-historical", false, true],
    ["project-exact", true, false],
  ]);
});

test("read-only shared Projects remain valid organization targets", () => {
  const readOnly = {
    ...project("project-read-only", "runner-1", "workspace-1"),
    audience: "organization" as const,
    canManage: false,
  };
  const [choice] = sessionProjectChoices(session(), [readOnly]);

  assert.deepEqual(choice, {
    id: readOnly.id,
    name: readOnly.name,
    audience: "organization",
    compatible: true,
    linkable: false,
    current: false,
  });
});

test("adopted sessions expose manageable unlinked Projects and fail closed for non-managers", () => {
  const manageable = {
    ...project("project-linkable", "runner-2", "other-workspace"),
    name: "Linkable",
    canManage: true,
  };
  const readOnly = {
    ...project("project-read-only", "runner-2", "other-workspace"),
    name: "Read Only",
    canManage: false,
  };

  const choices = sessionProjectChoices(session({ adopted: true, importLocationReady: true }), [readOnly, manageable]);

  assert.deepEqual(choices.map(({ id, compatible, linkable }) => [id, compatible, linkable]), [
    [manageable.id, false, true],
    [readOnly.id, false, false],
  ]);
});

test("adopted Project linking stays disabled until a runner-authoritative cwd is available", () => {
  const manageable = { ...project("project-linkable", "runner-2", "other-workspace"), canManage: true };
  const [choice] = sessionProjectChoices(session({ adopted: true, importLocationReady: false }), [manageable]);
  assert.equal(choice?.linkable, false);
});

test("Project assignment responses cannot erase or resurrect live turn projection", async () => {
  const store = new Store();
  const dispatch = (msg: ControlPlaneToUi) => store.dispatch({ type: "msg", msg });
  const base = session({
    id: "session-live",
    status: "running",
    runnerOnline: true,
    runnerProtocolVersion: 72,
  });
  dispatch({ type: "snapshot", runners: [], boxes: [], sessions: [base], runs: [], pods: [] });

  let resolveResponse!: (value: unknown) => void;
  const response = new Promise<unknown>((resolve) => { resolveResponse = resolve; });
  const mutation = persistProjectAssignment(async () => response, base.id, "project-next", false);

  dispatch({
    type: "session_upsert",
    session: {
      ...base,
      projectId: "project-next",
      activeTurnId: "turn-a",
      queued: [{ id: "prompt-b", text: "B" }],
      queueHeld: true,
    },
  });
  resolveResponse({ ...base, projectId: "project-next" });
  await mutation;
  assert.equal(store.getState().sessions.get(base.id)?.activeTurnId, "turn-a");
  assert.equal(store.getState().sessions.get(base.id)?.queueHeld, true);

  let resolveStaleResponse!: (value: unknown) => void;
  const staleResponse = new Promise<unknown>((resolve) => { resolveStaleResponse = resolve; });
  const secondMutation = persistProjectAssignment(async () => staleResponse, base.id, "project-next", true);
  dispatch({ type: "session_upsert", session: { ...base, projectId: "project-next" } });
  resolveStaleResponse({
    ...base,
    projectId: "project-next",
    activeTurnId: "turn-a",
    queued: [{ id: "prompt-b", text: "B" }],
    queueHeld: true,
  });
  await secondMutation;
  assert.equal(store.getState().sessions.get(base.id)?.activeTurnId, undefined);
  assert.equal(store.getState().sessions.get(base.id)?.queued, undefined);
  assert.equal(store.getState().sessions.get(base.id)?.queueHeld, undefined);
});

test("linking a missing Location remains actionable for the current Project", () => {
  assert.equal(shouldSubmitProjectAssignment("project-current", "project-current", true), true);
  assert.equal(shouldSubmitProjectAssignment("project-current", "project-current", false), false);
});

test("Project assignment copy identifies audiences and fails closed when sharing metadata is absent", () => {
  const team = { ...project("team-project", "runner-1", "workspace-1"), audience: "team" as const };
  const organization = { ...project("org-project", "runner-1", "workspace-1"), audience: "organization" as const };
  assert.equal(projectAudienceLabel("user"), "Personal Project");
  assert.equal(projectAudienceLabel("team"), "Team Project");
  assert.equal(projectAudienceLabel("organization"), "Organization Project");
  assert.equal(projectAudienceLabel(undefined), null);
  assert.equal(projectAudienceVisibilityLabel("user"), "Only the Project Owner");
  assert.equal(projectAudienceVisibilityLabel("team"), "Everyone on the Owning Team");
  assert.equal(projectAudienceVisibilityLabel("organization"), "Everyone in Your Organization");
  assert.equal(projectAudienceVisibilitySummary("user"), "Project Visibility: Only the Project Owner");
  assert.equal(projectAudienceVisibilitySummary("team"), "Project Visibility: Everyone on the Owning Team");
  assert.equal(projectAudienceVisibilitySummary("organization"), "Project Visibility: Everyone in Your Organization");
  assert.equal(projectAudienceVisibilitySummary(undefined), null);
  assert.equal(projectAssignmentAudienceConfirmation(session({ audience: "user" }), team), "team");
  assert.equal(projectAssignmentAudienceConfirmation(session({ audience: "team" }), team), null);
  assert.equal(projectAssignmentAudienceConfirmation(session({ audience: "user" }), organization), null,
    "organization filing preserves the narrower personal session audience");
  assert.equal(projectAssignmentAudienceConfirmation(session(), team), "unknown");
  assert.equal(projectAssignmentAudienceConfirmation(session({ audience: "user" }), project(
    "legacy-project", "runner-1", "workspace-1",
  )), "unknown", "an older control plane cannot silently bypass transcript-sharing consent");
});
