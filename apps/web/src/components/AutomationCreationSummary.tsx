import React from "react";
import type { AutomationCreationSnapshot } from "@wollipog/protocol";

/** The human reviews the complete saved configuration, not a summary supplied by the agent. */
export function AutomationCreationSummary({ snapshot }: { snapshot: AutomationCreationSnapshot }) {
  const { spec } = snapshot;
  const action = spec.action;
  const prompt = action.kind === "prompt_session" ? action.request.text :
    action.kind === "create_session" ? action.request.prompt : action.request.task;
  return <section aria-label="Create Automation Details">
    <p>Approve creating this automation once. Scheduled runs keep their own permissions, limits and approval requirements.</p>
    <dl className="facts">
      <div><dt>Name</dt><dd>{spec.name}</dd></div>
      <div><dt>Action</dt><dd>{action.kind === "create_session" ? "Create Session" : action.kind === "prompt_session" ? "Prompt Existing Session" : "Start Workflow Run"}</dd></div>
      {action.kind === "prompt_session" && action.request.slashCommand && <div><dt>Slash Command</dt><dd><code>{action.request.slashCommand}</code></dd></div>}
      {action.kind === "workflow_run" && <>
        <div><dt>Workflow</dt><dd>{action.request.workflowId}</dd></div>
        <div><dt>Workflow Version</dt><dd>{action.request.workflowVersion}</dd></div>
      </>}
      <div><dt>Schedule</dt><dd><code>{spec.cron}</code> · {spec.timezone}</dd></div>
      <div><dt>Next Occurrence</dt><dd>{new Date(snapshot.nextFireAt).toISOString()}</dd></div>
      <div><dt>Initial State</dt><dd>{spec.enabled ? "Enabled" : "Paused"}</dd></div>
      {action.kind === "prompt_session" ? <div><dt>Target Session</dt><dd>{action.sessionId}</dd></div> : <>
        <div><dt>Machine</dt><dd>{action.request.runnerId}</dd></div>
        <div><dt>Workspace</dt><dd>{action.request.workspaceId}</dd></div>
        <div><dt>Project</dt><dd>{action.request.projectId ?? "Workspace Assignment"}</dd></div>
        <div><dt>Workspace Strategy</dt><dd>{action.request.useWorktree ? "Worktree" : "In Place"}</dd></div>
      </>}
      <div><dt>Model</dt><dd>{action.request.config?.model ?? "Inherit at Run Time"}</dd></div>
      <div><dt>Reasoning Effort</dt><dd>{action.request.config?.effort ?? "Inherit at Run Time"}</dd></div>
      <div><dt>Permission Mode</dt><dd>{action.request.config?.permissionMode ?? "Inherit at Run Time"}</dd></div>
      <div><dt>Cost Limit per Run</dt><dd>${spec.limits.maxCostUsd}</dd></div>
      <div><dt>Tool-Call Limit per Run</dt><dd>{spec.limits.maxToolCalls}</dd></div>
      <div><dt>Prompt</dt><dd><div className="code-well"><pre>{prompt || "No additional prompt."}</pre></div></dd></div>
      <div><dt>Proposal Expires</dt><dd>{new Date(snapshot.expiresAt).toISOString()}</dd></div>
    </dl>
    {snapshot.effectiveTargets.length > 0 && <>
      <p>Unspecified settings are inherited at run time. This preview shows observed target defaults and explicit settings; it does not override future session settings.</p>
      <dl className="facts">{snapshot.effectiveTargets.map((target, index) => <div key={index}>
        <dt>Current Target Preview</dt><dd>{target.runnerId} / {target.workspaceId} / {target.agentId} ({target.role}): {target.config.model ?? "Provider Default"}, {target.config.effort ?? "Provider Default"}, {target.config.permissionMode ?? "Provider Default"}</dd>
      </div>)}</dl>
    </>}
    <details>
      <summary>Full Configuration</summary>
      <p>Includes exact installation bindings, alternate targets, workflow settings, notifications, concurrency and recovery policies.</p>
      <div className="code-well"><pre>{JSON.stringify(spec, null, 2)}</pre></div>
    </details>
    {!spec.enabled && <p>The automation will stay paused until a person enables it.</p>}
  </section>;
}
