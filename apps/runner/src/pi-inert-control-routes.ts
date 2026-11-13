/** Dormant #3922 inventory. Not imported by provider launch/discovery or capability projection.
 * Classification records where a request goes; it does not attest that remote effects are contained. */
import { createHash } from "node:crypto";
import { dispatch } from "./session-management-mcp.js";

export type PiControlRole = "ordinary" | "orchestrator" | "evidence";
export type PiControlRouteKind = "local-subprocess" | "local-file-read" | "remote-control-plane" | "unknown";
export type PiControlRemoteEffect = "control-plane" | "forge" | "unclassified";
const REMOTE_TOOLS: ReadonlySet<string> = new Set([
  "adjudicate_campaign_recommendation",
  "allocate_campaign_budget",
  "answer_descendant_question",
  "archive_session",
  "assign_campaign_work_item",
  "attach_worktree",
  "cancel_review_session",
  "close_github_issue",
  "complete_workflow_attempt",
  "consume_workflow_decision",
  "create_run",
  "create_session",
  "create_workflow_artifact",
  "create_workflow_definition",
  "create_workflow_run",
  "create_workflow_version",
  "create_worktree",
  "delete_governance_policy",
  "delete_worktree_refs",
  "discard_worktree",
  "dismiss_descendant_question",
  "dispatch_workflow_node",
  "execute_automation_creation",
  "execute_campaign_repository_addition",
  "execute_location_switch",
  "execute_workflow_decision",
  "get_agent_capabilities",
  "get_automation_creation",
  "get_campaign",
  "get_campaign_issue_scope",
  "get_campaign_repository_addition",
  "get_campaign_work_items",
  "get_descendant_ui_evidence_review",
  "get_descendant_video_evidence_provenance",
  "get_governance_policy",
  "get_location_switch",
  "get_provider_account_selection",
  "get_review_session",
  "get_session",
  "get_session_events",
  "get_steering_attempt",
  "get_workflow",
  "get_workflow_decision",
  "get_workflow_instance",
  "get_workflow_node",
  "hand_workflow_decision_to_owner",
  "handoff_session_result",
  "list_descendant_requests",
  "list_governance_policies",
  "list_review_sessions",
  "list_runners",
  "list_runs",
  "list_sessions",
  "list_steering_attempts",
  "list_workflow_decisions",
  "list_workflow_instances",
  "list_workflows",
  "park_on_pull_request",
  "prepare_descendant_ui_evidence_review",
  "prepare_descendant_video_evidence_review",
  "prompt_session",
  "reconcile_workflow_decision",
  "record_campaign_follow_up",
  "record_campaign_plan",
  "record_campaign_work_item_delivery",
  "release_queue_hold",
  "request_automation_creation",
  "request_campaign_issue_scope_change",
  "request_campaign_repository_addition",
  "request_github_issue_closure",
  "request_location_switch",
  "request_owner_decision",
  "request_review_session",
  "request_workflow_decision",
  "resolve_descendant_approval",
  "resolve_descendant_workflow_decision",
  "resolve_steering_attempt",
  "resolve_workflow_gate",
  "restart_session",
  "review_descendant_ui_evidence",
  "review_evidence_image",
  "select_worktree",
  "set_guardrails",
  "stop_background_job",
  "stop_session",
  "submit_evidence_verdict",
  "unarchive_session",
  "update_campaign_work_item",
  "upsert_governance_policy",
  "verify_campaign_child",
  "wait_session",
  "withdraw_descendant_workflow_decision",
  "withdraw_workflow_decision",
]);
export const PI_INERT_EXECUTABLE_ROUTES = Object.freeze([
  "model-bash", "rpc-bash", "user-bash", "agent-control-mcp", "mcp-gh-glab",
  "native-grep-rg", "native-find-fd", "native-powershell", "extension-exec",
]);
export function piControlRouteKind(name: string): PiControlRouteKind {
  if (name === "wait_pull_request") return "local-subprocess";
  if (name === "attach_session_artifact") return "local-file-read";
  return REMOTE_TOOLS.has(name) ? "remote-control-plane" : "unknown";
}
export interface PiControlCatalogTool { name: string; description: string; inputSchema: unknown }
export function classifyPiControlCatalog(tools: readonly PiControlCatalogTool[]) {
  if (!Array.isArray(tools) || tools.length > 128) throw new Error("Pi inert catalog refused.");
  const seen = new Set<string>();
  return tools.map(tool => {
    if (!tool || typeof tool.name !== "string" || !/^[a-z][a-z0-9_]{0,127}$/u.test(tool.name) ||
        seen.has(tool.name) || typeof tool.description !== "string" || !tool.inputSchema ||
        typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) throw new Error("Pi inert catalog refused.");
    seen.add(tool.name);
    let serialized: string;
    try { serialized = JSON.stringify([tool.name, tool.description, tool.inputSchema]); }
    catch { throw new Error("Pi inert catalog refused."); }
    if (Buffer.byteLength(serialized) > 131_072) throw new Error("Pi inert catalog refused.");
    const kind = piControlRouteKind(tool.name);
    const remoteEffects: PiControlRemoteEffect[] = kind === "unknown" ? ["unclassified"] :
      tool.name === "wait_pull_request" ? ["control-plane", "forge"] : ["control-plane"];
    return Object.freeze({ name: tool.name, kind,
      definitionSha256: createHash("sha256").update(serialized).digest("hex"),
      // Local describes an entry-point resource, not its full effects. Artifact upload and wait
      // progress reports still reach the CP; gh/glab also reach the forge outside this namespace.
      remoteEffects: Object.freeze(remoteEffects), transitiveEffects: "unproven" as const });
  }).sort((a, b) => a.name.localeCompare(b.name));
}
/** Exercise the actual role filter, with network disabled rather than an invented tool list. */
export async function piControlRoleInventory(role: PiControlRole) {
  if (!["ordinary", "orchestrator", "evidence"].includes(role)) throw new Error("Pi inert role refused.");
  const reply = await dispatch({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {
    cpUrl: "http://inert.invalid", token: "synthetic", selfSessionId: "synthetic",
    fetch: async () => { throw new Error("Pi inert inventory attempted a network request."); },
    ...(role === "orchestrator" ? { orchestrator: true } : {}),
    ...(role === "evidence" ? { uiEvidenceReviewer: true } : {}),
  });
  const routes = classifyPiControlCatalog(reply.result.tools);
  return Object.freeze({ role, routes: Object.freeze(routes),
    catalogSha256: createHash("sha256").update(JSON.stringify(routes)).digest("hex") });
}
/** This is an evidence-gap assessment, not an admission token or protected capability.
 * Even a fully recognized catalog retains transitive, mount/import and real-launch gaps. */
export function piInertActivationGaps(inventory: Awaited<ReturnType<typeof piControlRoleInventory>>) {
  const gaps = new Set(["actual-outer-mount-identity", "immutable-loaded-import-closure", "real-pi-launch-coverage"]);
  if (inventory.routes.some(route => route.kind === "unknown")) gaps.add("unknown-tool-route");
  if (inventory.routes.some(route => route.remoteEffects.includes("control-plane"))) gaps.add("remote-control-plane-effects");
  if (inventory.routes.some(route => route.remoteEffects.includes("forge"))) gaps.add("remote-forge-effects");
  return [...gaps].sort();
}
