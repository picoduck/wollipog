/** Browser-facing owner management API. Secrets appear only in create/rotate responses. */
import type { AssistantConnection, AssistantGrant } from "@wollipog/protocol";
import { relativeTime, titleCaseLabel } from "./format.js";

export type { AssistantGrant, AssistantConnection } from "@wollipog/protocol";
export type AssistantConnectionListItem = AssistantConnection & { lastUsedAt?: number | null };

export function assistantOperationTitle(id: string): string {
  return titleCaseLabel(id.replace(/[_:.]+/g, " "));
}

export function assistantConnectionAccessSummary(grant: AssistantGrant): string {
  const access = grant.operations === "all" ? "Full Access" : "Configured Access";
  const projects = grant.projects === "all" ? "All Projects" : `${grant.projects.length} Selected ${grant.projects.length === 1 ? "Project" : "Projects"}`;
  return `${access} · ${projects}`;
}

export function formatAssistantConnectionLastUsed(lastUsedAt: AssistantConnectionListItem["lastUsedAt"]): string {
  if (lastUsedAt === undefined) return "Last Use Unavailable";
  if (lastUsedAt === null) return "Never Used";
  return `Last used ${relativeTime(lastUsedAt)}`;
}

export interface AssistantConnectionsView {
  connections: AssistantConnectionListItem[];
  installation: {id: string; name: string; canRename: boolean};
  operations: {name: string; description: string}[];
  projects: {id: string; name: string}[];
}
export interface AssistantActivity {
  connection_id: string; grant_revision: number; operation: string;
  target_json: string; outcome: string; created_at: number;
  assistant: {id: string; name: string};
  targetLabel: string;
}
