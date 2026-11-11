/** Browser-facing owner management API. Secrets appear only in create/rotate responses. */
import type { AssistantConnection } from "@wollipog/protocol";
export type { AssistantGrant, AssistantConnection } from "@wollipog/protocol";
export interface AssistantConnectionsView {
  connections: AssistantConnection[];
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
