/** Separate opt-in workflow event policy (#3314), measured from terminal completion. */
export const WORKFLOW_EVENT_RETENTION_LIMITS = { minDays: 7, maxDays: 3650, suggestedDays: 90 } as const;
export const WORKFLOW_EVENT_RETENTION_DELAY_MS = 24 * 60 * 60_000;
export interface WorkflowEventRetentionCounts { instances: number; events: number }
export interface WorkflowEventRetentionView {
  retentionDays: number | null;
  source: "default" | "environment" | "organization";
  environmentDays: number | null;
  canManage: boolean;
  prunesFrom: number | null;
  nextRunAt: number | null;
  eligible: WorkflowEventRetentionCounts;
  lastRun: (WorkflowEventRetentionCounts & { finishedAt: number }) | null;
  limits: typeof WORKFLOW_EVENT_RETENTION_LIMITS;
  preview?: { retentionDays: number; eligible: WorkflowEventRetentionCounts; prunesFrom: number };
}
export interface UpdateWorkflowEventRetentionRequest { retentionDays: number | null }
/** Present even for a partly pruned or subsequently retried instance. Outcomes remain intact. */
export interface WorkflowEventHistoryPruned { prunedAt: number; eventCount: number; retentionDays: number }
