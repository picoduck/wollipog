/** Removing a Workspace from a Machine (#4123). Removal unregisters the Workspace only: its folder,
 * files, sessions, worktrees and credentials stay where they are. A Workspace added in Wollipog
 * lives in the control plane and is removed there. A Workspace from the runner's own
 * configuration is removed by the runner, which records the removal in its data directory so the
 * Workspace stays removed across restarts and reconnects. */

/** Where a Workspace came from: the runner's configuration, or Add Workspace in Wollipog. */
export type WorkspaceSource = "configured" | "managed";

/** Control plane → runner: stop advertising one configured Workspace. `path` is the path the
 * runner advertised, so a Workspace whose configuration changed meanwhile is refused. */
export interface RemoveWorkspaceMessage {
  type: "remove_workspace";
  requestId: string;
  runnerId: string;
  workspaceId: string;
  path: string;
}

/** Runner → control plane: the outcome. A refusal's `error` says what to resolve first. */
export interface RemoveWorkspaceResultMessage {
  type: "remove_workspace_result";
  requestId: string;
  ok: boolean;
  error?: string;
}

/** One reference that keeps a Workspace from being removed, named so the person can resolve it. */
export type WorkspaceRemovalBlocker =
  | { kind: "project_location"; projectId: string; projectName: string }
  | { kind: "session"; count: number }
  | { kind: "automation"; automationId: string; automationName: string };

/** The refusal sentence for a set of blockers: what uses the Workspace and what to do about it. */
export function workspaceRemovalBlockedMessage(blockers: readonly WorkspaceRemovalBlocker[]): string {
  const parts: string[] = [];
  const projects = blockers.flatMap((blocker) => blocker.kind === "project_location" ? [blocker.projectName] : []);
  const automations = blockers.flatMap((blocker) => blocker.kind === "automation" ? [blocker.automationName] : []);
  const sessions = blockers.reduce((total, blocker) => total + (blocker.kind === "session" ? blocker.count : 0), 0);
  if (projects.length) {
    parts.push(`Remove it from ${projects.length === 1 ? "the project" : "the projects"} ${quotedList(projects)} first.`);
  }
  if (sessions) {
    parts.push(`Archive the ${sessions === 1 ? "session" : `${sessions} sessions`} still using it first.`);
  }
  if (automations.length) {
    parts.push(`Change or delete ${automations.length === 1 ? "the automation" : "the automations"} ${quotedList(automations)} that ${automations.length === 1 ? "runs" : "run"} in it first.`);
  }
  return ["This workspace is still in use.", ...parts].join(" ");
}

function quotedList(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  if (quoted.length <= 2) return quoted.join(" and ");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}
